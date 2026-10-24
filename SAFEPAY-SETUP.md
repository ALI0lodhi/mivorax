# Online payments (Safepay) — setup

The store accepts **Cash on Delivery** out of the box. **Online card payments**
(Visa / Mastercard, plus JazzCash and Easypaisa) run through **Safepay**
(https://getsafepay.pk), Pakistan's hosted payment gateway. Card details are
entered on Safepay's own secure page — they never touch this server.

The code is already built and waiting. Online payment turns on the moment the
four Safepay values below are present in the server environment. Until then the
"Pay online" option stays hidden and nothing breaks.

## 1. Get the keys

You can test with a **free sandbox account** today — no business documents needed:

1. Sign up at **https://getsafepay.pk** and open the **Sandbox** dashboard.
2. Go to **Developers → API Keys** and copy:
   - **API key** (starts with `sec_…`) → `SAFEPAY_API_KEY`
   - **Signature / shared secret** → `SAFEPAY_V1_SECRET`
3. Go to **Developers → Webhooks**, add an endpoint (see step 3 below), and copy
   its **Webhook secret** → `SAFEPAY_WEBHOOK_SECRET`.

For real money, your client repeats this in the **Production** (live) dashboard
after their business is approved, and you swap in the live keys with
`SAFEPAY_ENV=production`. No code changes — same four variables.

## 2. Add them to the server

In `server/.env` (copied from `.env.example`):

```
SAFEPAY_ENV=sandbox
SAFEPAY_API_KEY=sec_xxxxxxxx
SAFEPAY_V1_SECRET=xxxxxxxx
SAFEPAY_WEBHOOK_SECRET=xxxxxxxx
# Only needed if the backend and storefront are on different domains:
# PUBLIC_SITE_URL=https://your-store.com
# PUBLIC_API_URL=https://api.your-store.com
```

Restart the server. Then in **Admin → Store settings**, tick **“Online card
payments (Safepay)”** and save. (The switch refuses to turn on until the keys
are present, so you can't half-configure it by accident.)

## 3. Point Safepay's webhook at the server

In the Safepay dashboard → **Webhooks**, set the endpoint URL to:

```
https://<your-backend-domain>/api/payments/safepay/webhook
```

This is how Safepay tells the store a payment succeeded. The server verifies
every webhook's signature and ignores anything unsigned or unrecognised.

## How a payment flows

1. Customer picks **Pay online** at checkout and places the order.
   The order is created as **`pending_payment`** — no stock is reserved yet.
2. They're redirected to Safepay's hosted page and pay with card / wallet.
3. Safepay confirms the payment to the server (via the webhook, and a second
   signed redirect as backup). The server marks the order **paid**, moves it to
   **confirmed**, and deducts stock — exactly once, even if notified twice.
4. The customer lands back on the store, which shows a live "confirming…" page
   until the payment is confirmed.

If a customer abandons the Safepay page, their bag is kept and the order stays
`pending_payment` (you can cancel it from the admin). Stock is only ever taken
once money is actually captured.

## Testing in sandbox

Use Safepay's sandbox test cards (listed in their dashboard docs). No real money
moves. Watch the order flip from **awaiting payment** to **paid online** in
**Admin → Orders** after you complete a test payment.
