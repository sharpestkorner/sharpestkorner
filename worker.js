// Cloudflare Worker: Daraja STK Push + booking email (free tier)
// Bindings/secrets needed (see setup steps):
//   KV namespace: BOOKINGS
//   Secrets: DARAJA_KEY, DARAJA_SECRET, SHORTCODE, PASSKEY, OWNER_EMAIL, RESEND_KEY, CALLBACK_SECRET
//   Vars: DARAJA_ENV ("sandbox" or "live"), ALLOWED_ORIGIN (e.g. https://yourname.github.io)

const CLASSES = {
  ai: { title: "AI Training and Account Creation", price: 3000 },
  darkweb: { title: "Dark WEB full masterclass", price: 3500 },
};

const cors = env => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});
const json = (env, data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors(env) } });

const base = () => "https://sandbox.safaricom.co.ke";

function normPhone(p) {
  p = String(p).replace(/[\s+-]/g, "");
  if (/^0[17]\d{8}$/.test(p)) return "254" + p.slice(1);
  if (/^254[17]\d{8}$/.test(p)) return p;
  return null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    // Which times are taken on a date
    if (url.pathname === "/slots") {
      const date = url.searchParams.get("date") || "";
      const list = await env.BOOKINGS.list({ prefix: `slot:${date}T` });
      return json(env, { taken: list.keys.map(k => k.name.split("T")[1]) });
    }

    // Poll payment status
    if (url.pathname === "/status") {
      const b = await env.BOOKINGS.get(`chk:${url.searchParams.get("id")}`, "json");
      return json(env, { status: b ? b.status : "unknown" });
    }

    // Start payment
    if (url.pathname === "/book" && req.method === "POST") {
      const d = await req.json().catch(() => ({}));
      const cls = CLASSES[d.cls];
      const phone = normPhone(d.phone);
      if (!cls) return json(env, { error: "Unknown class." }, 400);
      if (!phone) return json(env, { error: "Enter a valid Safaricom number." }, 400);
      if (!d.name || !/^\S+@\S+\.\S+$/.test(d.email || "")) return json(env, { error: "Name and valid email required." }, 400);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:00$/.test(d.time)) return json(env, { error: "Invalid date or time." }, 400);

      const slotKey = `slot:${d.date}T${d.time}`;
      if (await env.BOOKINGS.get(slotKey)) return json(env, { error: "That time was just taken. Pick another." }, 409);
      await env.BOOKINGS.put(slotKey, "pending", { expirationTtl: 300 }); // hold 5 min

      const auth = await fetch(`${base(env)}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: "Basic " + btoa(`${env.DARAJA_KEY}:${env.DARAJA_SECRET}`) },
      }).then(r => r.json());
      if (!auth.access_token) { await env.BOOKINGS.delete(slotKey); return json(env, { error: "Payment service unavailable." }, 502); }

      const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const stk = await fetch(`${base(env)}/mpesa/stkpush/v1/processrequest`, {
        method: "POST",
        headers: { Authorization: "Bearer " + auth.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: env.SHORTCODE,
          Password: btoa(env.SHORTCODE + env.PASSKEY + ts),
          Timestamp: ts,
          TransactionType: "CustomerPayBillOnline", // use CustomerBuyGoodsOnline for a Till
          Amount: cls.price,
          PartyA: phone,
          PartyB: env.SHORTCODE,
          PhoneNumber: phone,
          CallBackURL: `${url.origin}/callback?k=${env.CALLBACK_SECRET}`,
          AccountReference: "Masterclass",
          TransactionDesc: cls.title,
        }),
      }).then(r => r.json());

      if (stk.ResponseCode !== "0") { await env.BOOKINGS.delete(slotKey); return json(env, { error: "Could not send M-Pesa prompt." }, 502); }

      const id = stk.CheckoutRequestID;
      await env.BOOKINGS.put(`chk:${id}`, JSON.stringify({
        status: "pending", slotKey, cls: cls.title, price: cls.price,
        name: d.name, phone, email: d.email, date: d.date, time: d.time,
      }), { expirationTtl: 86400 });
      return json(env, { id });
    }

    // Daraja callback (called by Safaricom)
    if (url.pathname === "/callback" && req.method === "POST") {
      if (url.searchParams.get("k") !== env.CALLBACK_SECRET) return new Response("no", { status: 403 });
      const cb = (await req.json().catch(() => ({}))).Body?.stkCallback;
      if (!cb) return new Response("ok");
      const key = `chk:${cb.CheckoutRequestID}`;
      const b = await env.BOOKINGS.get(key, "json");
      if (!b || b.status !== "pending") return new Response("ok");

      if (cb.ResultCode === 0) {
        const receipt = (cb.CallbackMetadata?.Item || []).find(i => i.Name === "MpesaReceiptNumber")?.Value || "";
        b.status = "paid"; b.receipt = receipt;
        await env.BOOKINGS.put(b.slotKey, "paid"); // permanent
        await env.BOOKINGS.put(key, JSON.stringify(b), { expirationTtl: 86400 });
        await ctx_email(env, b);
      } else {
        b.status = "failed";
        await env.BOOKINGS.delete(b.slotKey);
        await env.BOOKINGS.put(key, JSON.stringify(b), { expirationTtl: 3600 });
      }
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  },
};

// Email you the booking via Resend (free: 100/day). Awaited inside callback for simplicity.
async function ctx_email(env, b) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.RESEND_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Bookings <onboarding@resend.dev>",
      to: [env.OWNER_EMAIL],
      reply_to: b.email,
      subject: `New booking: ${b.cls} on ${b.date} ${b.time}`,
      text: `Class: ${b.cls}\nAmount: KES ${b.price}\nM-Pesa receipt: ${b.receipt}\n\nName: ${b.name}\nPhone: ${b.phone}\nEmail: ${b.email}\n\nDate: ${b.date}\nTime: ${b.time} EAT`,
    }),
  });
}
