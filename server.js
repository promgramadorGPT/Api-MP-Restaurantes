const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const admin = require("firebase-admin"); // 1. Importa o Firebase Admin
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 🔥 INICIALIZAÇÃO DO FIREBASE ADMIN
// ==========================================
// Coloque o arquivo de chave do Firebase (firebase-key.json) na raiz do projeto no Render
const serviceAccount = require("./firebase-key.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://SEU-PROJETO-default-rtdb.firebaseio.com" // 👈 Substitua com a URL do seu Firebase DB
});

const db = admin.database();

// Mercado Pago Central (Para a rota antiga/geral)
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_TOKEN
});
const payment = new Payment(client);

// ==========================================
// ⚡ ROTA 1: Criar PIX
// ==========================================
app.post("/criar-pix", async (req, res) => {
  try {
    const { valor, pedidoId } = req.body;

    const result = await payment.create({
      body: {
        transaction_amount: Number(valor),
        description: `Pedido #${pedidoId}`,
        payment_method_id: "pix",
        payer: {
          email: "teste@email.com"
        }
      }
    });

    const pix = result.point_of_interaction.transaction_data;

    res.json({
      paymentId: result.id,
      qrCode: pix.qr_code,
      qrCodeBase64: pix.qr_code_base64
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 💳 ROTA 2: Criar Pagamento com Cartão (Rota Antiga - Central)
// ==========================================
app.post("/criar-pagamento-cartao", async (req, res) => {
  try {
    const { token, amount, installments, paymentMethodId, payer, email, pedidoId } = req.body;

    if (!token || !amount) {
      return res.status(400).json({ error: "Token ou valor (amount) inválidos." });
    }

    const result = await payment.create({
      body: {
        transaction_amount: Number(amount),
        token: token,
        description: `Pedido Loja #${pedidoId || 'encomenda'}`,
        installments: Number(installments || 1),
        payment_method_id: paymentMethodId,
        payer: {
          email: email || "teste_cartao@email.com",
          identification: payer?.identification || undefined, 
          first_name: payer?.first_name || undefined
        }
      }
    });

    res.json({
      paymentId: result.id,
      status: result.status, 
      statusDetail: result.status_detail
    });

  } catch (err) {
    console.log("Erro rota cartao:", err);
    const errMsg = err.message || "Erro interno no processamento do cartão.";
    res.status(500).json({ error: errMsg });
  }
});

// ==========================================
// 🏬 ROTA 3: Criar Pagamento por Loja (NOVA - Descentralizada)
// ==========================================
app.post("/criar-pagamento-loja", async (req, res) => {
  try {
    const { token, amount, installments, paymentMethodId, payer, email, pedidoId, lojaId } = req.body;

    if (!lojaId) {
      return res.status(400).json({ error: "O identificador da loja (lojaId) é obrigatório." });
    }

    if (!token || !amount) {
      return res.status(400).json({ error: "Token do cartão ou valor inválidos." });
    }

    // 1. Busca o mp_token privado do restaurante no Firebase Admin
    const snapshot = await db.ref(`restaurantes/${lojaId}/mp_token`).once("value");
    const lojaToken = snapshot.val();

    if (!lojaToken) {
      return res.status(400).json({ error: "Esta loja ainda não cadastrou a conta do Mercado Pago." });
    }

    // 2. Conecta ao Mercado Pago usando a chave DA LOJA
    const clientLoja = new MercadoPagoConfig({ accessToken: lojaToken });
    const paymentLoja = new Payment(clientLoja);

    // 3. Executa a transação (dinheiro vai 100% para a loja)
    const result = await paymentLoja.create({
      body: {
        transaction_amount: Number(amount),
        token: token,
        description: `Pedido #${pedidoId || 'encomenda'}`,
        installments: Number(installments || 1),
        payment_method_id: paymentMethodId,
        payer: {
          email: email || "cliente@email.com",
          identification: payer?.identification || undefined, 
          first_name: payer?.first_name || undefined
        }
      }
    });

    console.log(`💳 Transação Loja ${lojaId} processada. ID: ${result.id} | Status: ${result.status}`);

    res.json({
      paymentId: result.id,
      status: result.status, 
      statusDetail: result.status_detail
    });

  } catch (err) {
    console.log("Erro rota loja:", err);
    const errMsg = err.message || "Erro interno no processamento do cartão da loja.";
    res.status(500).json({ error: errMsg });
  }
});

// ==========================================
// 🔍 ROTA 4: Verificar Status
// ==========================================
app.get("/status/:id", async (req, res) => {
  try {
    const result = await payment.get({
      id: req.params.id
    });

    res.json({
      status: result.status
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(3000, () => {
  console.log("🔥 API rodando na porta 3000");
});
