# API Mercado Pago — produção

## O que foi corrigido
- Token privado da loja: `restaurantes_privado/{lojaId}/mp_token`.
- Autenticação do cliente com Firebase ID Token.
- O servidor lê o pedido em `pedidos/{pedidoKey}` e usa `pedido.total`; ignora `amount` enviado pelo navegador.
- Confere `clienteUid`, `lojaId`, pedido pendente e loja ativa.
- Idempotência para evitar cobranças duplicadas.
- Registro em `pagamentos_por_pedido/{pedidoKey}` e `pagamentos/{paymentId}`.
- Atualiza `pedidos/{pedidoKey}` com status e ID do Mercado Pago.
- Consulta de status usando o token da própria loja.
- Webhook com validação HMAC `x-signature`.
- Helmet, CORS por allowlist e rate limit.

## Deploy
1. Suba `server.js` e `package.json` no Render/servidor.
2. Configure as variáveis de `.env.example`.
3. Não envie `firebase-key.json` para Git. Prefira `FIREBASE_SERVICE_ACCOUNT_JSON` como secret do servidor.
4. No Mercado Pago, configure Webhooks para o evento `payment`, usando a URL de `MP_WEBHOOK_URL`, e copie a chave secreta para `MP_WEBHOOK_SECRET`.
5. Para produção com várias lojas, o modelo recomendado pelo Mercado Pago é OAuth: o vendedor autoriza o marketplace e o servidor recebe/renova o Access Token e refresh token. Tokens de vendedor obtidos via OAuth têm validade limitada e precisam ser renovados.
6. O frontend correspondente precisa enviar `Authorization: Bearer <Firebase ID Token>` para `/criar-pagamento-loja`.

## Estrutura Firebase esperada
`restaurantes_privado/{lojaId}/mp_token`
`restaurantes/{lojaId}/ownerUid`
`pedidos/{pedidoKey}/clienteUid`
`pedidos/{pedidoKey}/lojaId`
`pedidos/{pedidoKey}/total`
`pedidos/{pedidoKey}/status`

## Importante
O código não contém nenhuma chave real. Não coloque Access Token, Client Secret ou Webhook Secret no frontend.


## V2.1 — Device ID antifraude
A rota `/criar-pagamento-loja` aceita o header `X-meli-session-id` enviado pelo checkout e o repassa ao Mercado Pago na criação do pagamento. O header é opcional para manter compatibilidade, mas o V51 do frontend passa a enviá-lo quando disponível.
