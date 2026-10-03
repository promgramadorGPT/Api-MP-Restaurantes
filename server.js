const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(v => v.trim()).filter(Boolean);
app.use(helmet());
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-meli-session-id']
}));
app.use(express.json({ limit: '256kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 60),
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// ==========================================
// FIREBASE ADMIN
// ==========================================
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  return require('./firebase-key.json');
}

const serviceAccount = loadServiceAccount();
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL || 'https://app-delivery-frontend-da5d0-default-rtdb.firebaseio.com'
});

const db = admin.database();
const auth = admin.auth();

// ==========================================
// HELPERS
// ==========================================
const ok = (res, data) => res.status(200).json(data);
const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function getBearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

async function requireFirebaseUser(req, res, next) {
  try {
    const token = getBearer(req);
    if (!token) return fail(res, 401, 'Autenticación requerida.');
    req.user = await auth.verifyIdToken(token);
    return next();
  } catch (err) {
    console.error('Auth Firebase:', err.message);
    return fail(res, 401, 'Sesión inválida o expirada.');
  }
}

function normalizeStatus(status) {
  return String(status || '').toLowerCase();
}

function paymentStatusToApp(status) {
  const s = normalizeStatus(status);
  if (s === 'approved') return 'Aprobado';
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(s)) return 'Rechazado';
  return 'Pendiente de pago';
}

function validPositiveNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

function makeIdempotencyKey() {
  return crypto.randomUUID().replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
}

async function getSellerToken(lojaId) {
  const snap = await db.ref(`restaurantes_privado/${lojaId}/mp_token`).once('value');
  const token = snap.val();
  return typeof token === 'string' && token.trim() ? token.trim() : null;
}

async function getOrderForUser(pedidoKey, userUid, lojaId) {
  const snap = await db.ref(`pedidos/${pedidoKey}`).once('value');
  if (!snap.exists()) return null;
  const pedido = snap.val();
  if (pedido.clienteUid !== userUid) return null;
  if (pedido.lojaId !== lojaId) return null;
  return pedido;
}

async function getStore(lojaId) {
  const snap = await db.ref(`restaurantes/${lojaId}`).once('value');
  return snap.exists() ? snap.val() : null;
}

async function createOrReusePaymentAttempt(pedidoKey, lojaId) {
  const ref = db.ref(`pagamentos_por_pedido/${pedidoKey}`);
  const now = Date.now();
  let chosen = null;
  await ref.transaction(current => {
    if (current && current.paymentIdMP) {
      const existingStatus = normalizeStatus(current.status);
      if (!['rejected', 'cancelled', 'refunded', 'charged_back'].includes(existingStatus)) {
        chosen = current;
        return current;
      }
    }
    if (current && current.status === 'creating' && Number(current.createdAt) > now - 10 * 60 * 1000 && current.idempotencyKey) {
      chosen = current;
      return current;
    }
    const next = {
      lojaId,
      pedidoKey,
      idempotencyKey: makeIdempotencyKey(),
      status: 'creating',
      createdAt: now,
      updatedAt: now
    };
    chosen = next;
    return next;
  });
  return chosen;
}

async function savePaymentRecord(pedidoKey, payment) {
  const record = {
    lojaId: payment.lojaId,
    pedidoKey,
    paymentIdMP: String(payment.id),
    status: payment.status,
    statusDetail: payment.status_detail || null,
    transactionAmount: Number(payment.transaction_amount),
    updatedAt: Date.now()
  };
  await db.ref(`pagamentos_por_pedido/${pedidoKey}`).update(record);
  await db.ref(`pagamentos/${payment.id}`).set(record);
}

async function updateOrderPayment(pedidoKey, payment) {
  const appStatus = paymentStatusToApp(payment.status);
  await db.ref(`pedidos/${pedidoKey}`).update({
    pagoStatus: appStatus,
    paymentIdMP: payment.id,
    paymentStatusMP: payment.status,
    paymentStatusDetailMP: payment.status_detail || null,
    pagoAtualizadoEm: new Date().toISOString()
  });
}

function parseSignature(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function verifyWebhookSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return false;
  const signature = parseSignature(req.headers['x-signature']);
  const requestId = req.headers['x-request-id'];
  const dataId = req.query['data.id'] || req.query.data_id || '';
  if (!signature.v1 || !signature.ts || !requestId || !dataId) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${signature.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.v1, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ==========================================
// HEALTH
// ==========================================
app.get('/health', (req, res) => ok(res, { ok: true, service: 'api-mp-restaurantes' }));

// ==========================================
// PAGAMENTO POR LOJA — PRODUÇÃO
// ==========================================
app.post('/criar-pagamento-loja', requireFirebaseUser, async (req, res) => {
  try {
    const {
      token,
      installments,
      paymentMethodId,
      payer,
      email,
      pedidoKey,
      pedidoId,
      lojaId
    } = req.body || {};

    if (!lojaId || typeof lojaId !== 'string') return fail(res, 400, 'lojaId inválido.');
    if (!pedidoKey || typeof pedidoKey !== 'string') return fail(res, 400, 'pedidoKey é obrigatório.');
    if (!token || typeof token !== 'string') return fail(res, 400, 'Token do cartão inválido.');
    if (!paymentMethodId || typeof paymentMethodId !== 'string') return fail(res, 400, 'Meio de pagamento inválido.');

    const parcelas = Number(installments || 1);
    if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 24) return fail(res, 400, 'Número de parcelas inválido.');

    const pedido = await getOrderForUser(pedidoKey, req.user.uid, lojaId);
    if (!pedido) return fail(res, 404, 'Pedido não encontrado.');

    if (pedido.status !== 'Pendiente') return fail(res, 409, 'Este pedido não está disponível para pagamento.');
    const pedidoPagoStatus = normalizeStatus(pedido.paymentStatusMP || pedido.pagoStatus);
    if (pedido.paymentIdMP && !['rejected', 'cancelled', 'refunded', 'charged_back'].includes(pedidoPagoStatus)) {
      return ok(res, { paymentId: pedido.paymentIdMP, status: pedido.paymentStatusMP || 'approved', statusDetail: 'already_processed' });
    }

    const total = Number(pedido.total);
    if (!validPositiveNumber(total)) return fail(res, 400, 'Total do pedido inválido.');

    const loja = await getStore(lojaId);
    if (!loja) return fail(res, 404, 'Loja não encontrada.');
    if (loja.activo === false || loja.activa === false) return fail(res, 409, 'Esta loja no está disponible.');

    const lojaToken = await getSellerToken(lojaId);
    if (!lojaToken) return fail(res, 409, 'Esta tienda aún no tiene una cuenta de Mercado Pago configurada.');

    const attempt = await createOrReusePaymentAttempt(pedidoKey, lojaId);
    if (attempt.paymentIdMP) {
      return ok(res, {
        paymentId: attempt.paymentIdMP,
        status: attempt.status,
        statusDetail: attempt.statusDetail || 'already_created'
      });
    }

    const clientLoja = new MercadoPagoConfig({ accessToken: lojaToken });
    const paymentLoja = new Payment(clientLoja);

    const payerData = {
      email: email || payer?.email || pedido?.cliente?.email || 'cliente@email.com'
    };
    if (payer?.identification?.number) {
      payerData.identification = {
        type: payer.identification.type || 'CPF',
        number: String(payer.identification.number)
      };
    } else if (pedido?.cliente?.documento) {
      payerData.identification = {
        type: pedido.cliente.documentoTipo || 'CPF',
        number: String(pedido.cliente.documento)
      };
    }

    const deviceSessionId = String(req.headers['x-meli-session-id'] || '').trim().slice(0, 200);

    const body = {
      transaction_amount: total,
      token,
      description: `Pedido #${pedido.numeroPedido || pedidoId || pedidoKey}`.slice(0, 150),
      installments: parcelas,
      payment_method_id: paymentMethodId,
      payer: payerData
    };

    if (process.env.MP_WEBHOOK_URL) body.notification_url = process.env.MP_WEBHOOK_URL;

    const requestOptions = { idempotencyKey: attempt.idempotencyKey };
    if (deviceSessionId) requestOptions.headers = { 'X-meli-session-id': deviceSessionId };

    const result = await paymentLoja.create({
      body,
      requestOptions
    });

    await savePaymentRecord(pedidoKey, {
      lojaId,
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      transaction_amount: result.transaction_amount
    });
    await updateOrderPayment(pedidoKey, result);

    console.log(`💳 Loja ${lojaId} | pedido ${pedidoKey} | MP ${result.id} | ${result.status}`);

    return ok(res, {
      paymentId: result.id,
      status: result.status,
      statusDetail: result.status_detail
    });
  } catch (err) {
    console.error('Erro pagamento por loja:', err.cause || err);
    const cause = err.cause?.[0];
    return fail(res, 502, cause?.description || err.message || 'Erro interno no processamento do pagamento.', {
      statusDetail: cause?.code || undefined
    });
  }
});

// ==========================================
// STATUS DE PAGAMENTO — SEM TOKEN DO CLIENTE
// ==========================================
app.get('/status-loja/:lojaId/:paymentId', requireFirebaseUser, async (req, res) => {
  try {
    const { lojaId, paymentId } = req.params;
    const snap = await db.ref(`pagamentos/${paymentId}`).once('value');
    const map = snap.val();
    if (!map || map.lojaId !== lojaId) return fail(res, 404, 'Pagamento não encontrado.');

    const pedido = await getOrderForUser(map.pedidoKey, req.user.uid, lojaId);
    if (!pedido) return fail(res, 403, 'No autorizado.');

    const token = await getSellerToken(lojaId);
    if (!token) return fail(res, 409, 'Token da loja indisponível.');

    const paymentClient = new Payment(new MercadoPagoConfig({ accessToken: token }));
    const result = await paymentClient.get({ id: paymentId });
    await updateOrderPayment(map.pedidoKey, result);

    return ok(res, { paymentId: result.id, status: result.status, statusDetail: result.status_detail });
  } catch (err) {
    console.error('Erro status loja:', err.cause || err);
    return fail(res, 502, err.cause?.[0]?.description || err.message || 'Erro ao consultar pagamento.');
  }
});

// ==========================================
// WEBHOOK MERCADO PAGO
// ==========================================
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) return res.sendStatus(401);

    const type = req.body?.type || req.query.type;
    if (type !== 'payment') return res.sendStatus(200);

    const paymentId = String(req.body?.data?.id || req.query['data.id'] || '');
    if (!paymentId) return res.sendStatus(200);

    const mapSnap = await db.ref(`pagamentos/${paymentId}`).once('value');
    const map = mapSnap.val();
    if (!map?.lojaId || !map?.pedidoKey) return res.sendStatus(200);

    const token = await getSellerToken(map.lojaId);
    if (!token) return res.sendStatus(200);

    const paymentClient = new Payment(new MercadoPagoConfig({ accessToken: token }));
    const result = await paymentClient.get({ id: paymentId });

    // Não confiar no body do webhook para status/valor: consulta o pagamento autenticado na conta da loja.
    await savePaymentRecord(map.pedidoKey, {
      lojaId: map.lojaId,
      id: result.id,
      status: result.status,
      status_detail: result.status_detail,
      transaction_amount: result.transaction_amount
    });
    await updateOrderPayment(map.pedidoKey, result);

    console.log(`🔔 Webhook MP ${paymentId} | pedido ${map.pedidoKey} | ${result.status}`);
    return res.sendStatus(200);
  } catch (err) {
    console.error('Erro webhook Mercado Pago:', err.cause || err);
    return res.sendStatus(500);
  }
});

// ==========================================
// LEGADO: PIX/CARTÃO CENTRAL
// Mantidos somente para compatibilidade. Não usar no checkout por loja.
// ==========================================
const centralToken = process.env.MP_TOKEN;
const centralPayment = centralToken ? new Payment(new MercadoPagoConfig({ accessToken: centralToken })) : null;

app.post('/criar-pix', async (req, res) => {
  try {
    if (!centralPayment) return fail(res, 503, 'Pagamento central desativado.');
    const { valor, pedidoId } = req.body || {};
    if (!validPositiveNumber(valor)) return fail(res, 400, 'Valor inválido.');
    const result = await centralPayment.create({
      body: { transaction_amount: Number(valor), description: `Pedido #${pedidoId || 'encomenda'}`, payment_method_id: 'pix', payer: { email: 'teste@email.com' } },
      requestOptions: { idempotencyKey: makeIdempotencyKey() }
    });
    const pix = result.point_of_interaction?.transaction_data;
    return ok(res, { paymentId: result.id, qrCode: pix?.qr_code, qrCodeBase64: pix?.qr_code_base64 });
  } catch (err) {
    console.error('Erro PIX central:', err.cause || err);
    return fail(res, 502, err.cause?.[0]?.description || err.message || 'Erro PIX.');
  }
});

app.get('/status/:id', async (req, res) => {
  try {
    if (!centralPayment) return fail(res, 503, 'Pagamento central desativado.');
    const result = await centralPayment.get({ id: req.params.id });
    return ok(res, { status: result.status });
  } catch (err) {
    return fail(res, 502, err.message || 'Erro ao consultar status.');
  }
});

// ==========================================
// ERROS / START
// ==========================================
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  return fail(res, 500, 'Erro interno.');
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`🔥 API Mercado Pago rodando na porta ${PORT}`));
