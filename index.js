import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import nodemailer from "nodemailer";

dotenv.config();

const app = express();

/* ==================== Mail Transporter ==================== */
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT || 587),
  secure: false, // 587 -> STARTTLS
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// (Opsiyonel) Boot sırasında SMTP doğrulaması (log için)
transporter.verify().then(
  () => console.log("[mail] SMTP ready"),
  (err) => console.warn("[mail] SMTP verify failed:", err?.message || err)
);

function escapeHtml(s = "") {
  return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

async function sendHandoffEmail({ kind, payload }) {
  const subject = kind === "reservation" ? "Yeni Rezervasyon" : "Yeni Sipariş";

  const html = `
    <h3>${subject}</h3>
    <pre style="font-size:14px;background:#f6f6f6;padding:12px;border-radius:8px">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    <p>Gönderim: ${new Date().toLocaleString()}</p>
  `;

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: `[${subject}] ${payload?.full_name || ""}`,
    html,
    text: `${subject}\n\n${JSON.stringify(payload, null, 2)}`
  });

  console.log("[mail] info.messageId:", info?.messageId);
  console.log("[mail] accepted:", info?.accepted);
  console.log("[mail] rejected:", info?.rejected);
  console.log("[mail] envelope:", info?.envelope);
  console.log("[mail] response:", info?.response);

  return info;
}

/* ==================== App Middleware ==================== */
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

// Basit request log
app.use((req, res, next) => {
  const t = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t}ms`);
  });
  next();
});

// Health + Static
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static("public"));
app.get("/", (_req, res) => res.redirect("/test.html"));

/* ==================== OpenAI Config ==================== */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.ASSISTANT_ID;
const OPENAI_BASE    = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const PORT           = process.env.PORT || 8787;

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing OPENAI_API_KEY or ASSISTANT_ID in .env");
  process.exit(1);
}

/* ==================== Helpers ==================== */
async function openAI(path, { method = "GET", body } = {}) {
  const res = await fetch(`${OPENAI_BASE}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "assistants=v2",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI ${method} ${path} ${res.status}: ${errText}`);
  }
  return res.json();
}

// Assistant yanıtından handoff JSON çıkar
function extractHandoff(text) {
  if (!text) return null;

  // 1) Etiketli blok: ```handoff:order ...``` | ```handoff:reservation ...```
  const tagged = /```handoff:(reservation|order)\s*([\s\S]*?)```/i.exec(text);
  if (tagged) {
    const kind = tagged[1].toLowerCase();
    try {
      const payload = JSON.parse(tagged[2]);
      return { kind, payload, raw: tagged[0] };
    } catch (e) {
      console.error("handoff JSON parse error (tagged):", e);
    }
  }

  // 2) Etiket yoksa: herhangi bir ```json ...``` bloğu
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of blocks) {
    try {
      const payload = JSON.parse(m[1]);
      const isOrder = Array.isArray(payload?.items) && payload.items.length > 0;
      const isReservation = !!(payload?.party_size && payload?.date && payload?.time);
      if (isOrder)       return { kind: "order",       payload, raw: m[0] };
      if (isReservation) return { kind: "reservation", payload, raw: m[0] };
    } catch (_e) {}
  }
  return null;
}

/* ==================== Rate Limit ==================== */
app.use(rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ==================== STREAMING (Typing Effect) — DÜZELTİLMİŞ ==================== */
/* Tek ve doğru yerde tanımlı SSE proxy: /threads/{threadId}/runs  + stream:true */
app.post("/api/chat/stream", chatLimiter, async (req, res) => {
  try {
    const { threadId, message } = req.body || {};
    if (!threadId || !message) {
      return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
    }

    // SSE başlıkları (proxy buffer’ları kapat)
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let clientClosed = false;
    req.on("close", () => { clientClosed = true; try { res.end(); } catch {} });

    // 1) Kullanıcı mesajını threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2) Run'ı STREAM modda başlat (DOĞRU YÖNTEM)
    //    /threads/{threadId}/runs  +  body: { assistant_id, stream:true }
    const upstream = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify({ assistant_id: ASSISTANT_ID, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(`OpenAI stream start failed ${upstream.status}: ${errText}`);
    }

    // Handoff tespiti için metni biriktirelim
    let buffer = "";
    let accText = "";
    const decoder = new TextDecoder();

    // 3) OpenAI’den gelen SSE’yi olduğu gibi forward et + text’i parçalar halinde topla
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // chunk'ı müşteriye aktar (typing effect)
      res.write(value);

      // aynı anda parse etmeye çalış (handoff için)
      const piece = decoder.decode(value, { stream: true });
      buffer += piece;

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const evt = JSON.parse(dataStr);
          // delta parçaları
          if (evt?.delta?.content && Array.isArray(evt.delta.content)) {
            for (const c of evt.delta.content) {
              if (c?.type === "text" && c?.text?.value) accText += c.text.value;
            }
          }
          // tamamlanmış bloklar
          if (evt?.message?.content && Array.isArray(evt.message.content)) {
            for (const c of evt.message.content) {
              if (c?.type === "text" && c?.text?.value) accText += c.text.value;
            }
          }
        } catch (_) {}
      }

      if (clientClosed) break;
    }

    // 4) Stream bitti → handoff varsa maille
    try {
      const handoff = extractHandoff(accText);
      if (handoff) {
        await sendHandoffEmail(handoff);
        console.log(`[handoff][stream] emailed: ${handoff.kind}`);
      }
    } catch (e) {
      console.error("[handoff][stream] email failed:", e);
    }

    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
  } catch (e) {
    console.error("stream_failed:", e);
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
      res.end();
    } catch {}
  }
});

/* ==================== Routes ==================== */
// 1) Thread oluştur
app.post("/api/chat/init", chatLimiter, async (req, res) => {
  try {
    const thread = await openAI("/threads", { method: "POST", body: {} });
    return res.json({ threadId: thread.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "init_failed", detail: String(e) });
  }
});

// 2) Mesaj gönder + run başlat + poll + yanıtı getir (non-stream)
app.post("/api/chat/message", chatLimiter, async (req, res) => {
  const { threadId, message } = req.body || {};
  if (!threadId || !message) {
    return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
  }

  try {
    // 2.a) Mesajı threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2.b) Run oluştur
    const run = await openAI(`/threads/${threadId}/runs`, {
      method: "POST",
      body: { assistant_id: ASSISTANT_ID },
    });

    // 2.c) Run tamamlanana kadar bekle (poll)
    let runStatus = run.status;
    const runId = run.id;
    const started = Date.now();
    const TIMEOUT_MS = 60_000;

    while (runStatus !== "completed") {
      if (Date.now() - started > TIMEOUT_MS) {
        throw new Error("Run polling timeout");
      }
      await new Promise(r => setTimeout(r, 1200));
      const polled = await openAI(`/threads/${threadId}/runs/${runId}`);
      runStatus = polled.status;
      if (["failed","cancelled","expired"].includes(runStatus)) {
        throw new Error(`Run status: ${runStatus}`);
      }
    }

    // 2.d) Mesajları çek (en yeni asistan mesajını al)
    const msgs = await openAI(`/threads/${threadId}/messages?order=desc&limit=10`);
    const assistantMsg = (msgs.data || []).find(m => m.role === "assistant");

    // İçerik metnini ayıkla
    let text = "";
    if (assistantMsg?.content) {
      for (const part of assistantMsg.content) {
        if (part.type === "text" && part.text?.value) {
          text += part.text.value + "\n";
        }
      }
      text = text.trim();
    }

    // --- Handoff JSON çıkar + e-posta ile gönder ---
    const handoff = extractHandoff(text);
    if (handoff) {
      try {
        await sendHandoffEmail(handoff);
        console.log(`[handoff] emailed: ${handoff.kind}`);
      } catch (e) {
        console.error("handoff email failed:", e);
      }
      // JSON'u kullanıcıya göstermemek için metinden çıkar
      if (handoff?.raw) text = text.replace(handoff.raw, "").trim();
    }

    return res.json({
      status: "ok",
      threadId,
      message: text || "(Yanıt metni bulunamadı)",
      handoff: handoff ? { kind: handoff.kind } : null,
      raw: assistantMsg || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "message_failed", detail: String(e) });
  }
});

/* ==================== Mail Isolated Test Endpoint (opsiyonel) ==================== */
app.post("/_mail_test", async (_req, res) => {
  try {
    const info = await sendHandoffEmail({
      kind: "order",
      payload: { full_name: "Mail Test", items: [{ sku_or_name: "Test", qty: 1 }] }
    });
    res.json({
      ok: true,
      messageId: info?.messageId,
      accepted: info?.accepted,
      rejected: info?.rejected,
      response: info?.response
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
