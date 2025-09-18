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
    text: `${subject}\n\n${JSON.stringify(payload, null, 2)}` // düz metin de ekleyelim
  });

  // 🔎 Önemli: accepted/rejected/envelope/response logla
  console.log("[mail] info.messageId:", info?.messageId);
  console.log("[mail] accepted:", info?.accepted);
  console.log("[mail] rejected:", info?.rejected);
  console.log("[mail] envelope:", info?.envelope);
  console.log("[mail] response:", info?.response);

  return info;
}


/* ==================== App Middleware ==================== */
app.set("trust proxy", 1);                // Render/Railway gerçek IP için
app.use(cors());                          // İstersen allowlist'e çevirirsin
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

  // 1) Önce etiketli blokları dene: ```handoff:order ...``` | ```handoff:reservation ...```
  const tagged = /```handoff:(reservation|order)\s*([\s\S]*?)```/i.exec(text);
  if (tagged) {
    const kind = tagged[1].toLowerCase();
    try {
      const payload = JSON.parse(tagged[2]);
      return { kind, payload, raw: tagged[0] };
    } catch (e) {
      console.error("handoff JSON parse error (tagged):", e);
      // fallthrough
    }
  }

  // 2) Etiket yoksa: herhangi bir ```json ...``` bloğunu ara ve JSON parse et
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const m of blocks) {
    try {
      const payload = JSON.parse(m[1]);

      // Heuristik sınıflandırma
      const isOrder =
        Array.isArray(payload?.items) && payload.items.length > 0;
      const isReservation =
        (payload?.party_size && payload?.date && payload?.time) ? true : false;

      if (isOrder)  return { kind: "order",       payload, raw: m[0] };
      if (isReservation) return { kind: "reservation", payload, raw: m[0] };

      // İleride başka tipler eklenirse buraya kural konur.
    } catch (_e) {
      /* geçersiz JSON'sa atla */
    }
  }

  return null;
}


/* ==================== Rate Limit ==================== */
// Tüm app için hafif limit (opsiyonel)
app.use(rateLimit({
  windowMs: 60_000,
  max: 120,                 // tüm yollar toplamı
  standardHeaders: true,
  legacyHeaders: false,
}));

// Chat için daha sıkı limit
const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,                  // IP başına dakikada 30 chat isteği
  standardHeaders: true,
  legacyHeaders: false,
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

// 2) Mesaj gönder + run başlat + poll + yanıtı getir
app.post("/api/chat/message", chatLimiter, async (req, res) => {
  const { threadId, message } = req.body || {};
  if (!threadId || !message) {
    return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
  }
// 2.bis) STREAMING: Mesaj + Run(stream) + SSE forward
app.post("/api/chat/stream", async (req, res) => {
  const { threadId, message } = req.body || {};
  if (!threadId || !message) {
    return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
  }

  try {
    // 1) Kullanıcı mesajını threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2) SSE başlıklarını ayarla
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Render/NGINX gibi proxy’lerde chunk hemen gitsin
    if (res.flushHeaders) res.flushHeaders();

    // 3) Run’ı STREAM modunda başlat ve OpenAI’nin SSE’sini forward et
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
      const errTxt = await upstream.text().catch(()=> "");
      res.write(`data: ${JSON.stringify({ error: `openai_stream_failed ${upstream.status}`, detail: errTxt.slice(0,300) })}\n\n`);
      return res.end();
    }

    // 4) OpenAI’den gelen SSE’yi satır satır aynen ilet
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    let closed = false;
    req.on("close", () => { closed = true; try { upstream.body.cancel(); } catch {} });

    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);              // "event:" / "data:" satırlarını aynen geçiriyoruz
    }

    // 5) Bitti işareti
    res.write("data: [DONE]\n\n");
    return res.end();

  } catch (e) {
    console.error("stream_error:", e);
    try {
      res.write(`data: ${JSON.stringify({ error: "server_stream_error", detail: String(e).slice(0,300) })}\n\n`);
    } catch {}
    return res.end();
  }
});

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
    const TIMEOUT_MS = 60_000; // 60 sn

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

    // İçerik metnini ayıkla (text parçaları)
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
    }
    // JSON'u kullanıcıya göstermemek için metinden çıkar
    if (handoff?.raw) {
      text = text.replace(handoff.raw, "").trim();
    }

    return res.json({
      status: "ok",
      threadId,
      message: text || "(Yanıt metni bulunamadı)",
      handoff: handoff ? { kind: handoff.kind } : null, // UI isterse görsün
      raw: assistantMsg || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "message_failed", detail: String(e) });
  }
});

/* ==================== STREAMING (Typing Effect) ==================== */
// OpenAI Assistants v2 SSE proxy: /api/chat/stream
app.post("/api/chat/stream", chatLimiter, async (req, res) => {
  try {
    const { threadId, message } = req.body || {};
    if (!threadId || !message) {
      return res.status(400).json({ error: "missing_params", detail: "threadId and message are required" });
    }

    // SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      // CORS gerekiyorsa, app.use(cors()) ile zaten açık
    });

    // Client bağlantısı kapatılırsa upstream'i iptal edelim
    let clientClosed = false;
    req.on("close", () => {
      clientClosed = true;
      try { res.end(); } catch {}
    });

    // 1) Kullanıcı mesajını threade ekle
    await openAI(`/threads/${threadId}/messages`, {
      method: "POST",
      body: { role: "user", content: message },
    });

    // 2) Run'ı streaming modda başlat
    const upstream = await fetch(`${OPENAI_BASE}/threads/${threadId}/runs/stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({ assistant_id: ASSISTANT_ID }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(`OpenAI stream start failed ${upstream.status}: ${errText}`);
    }

    // Gelen metni biriktireceğiz (handoff için)
    let buffer = "";
    let accText = "";
    const decoder = new TextDecoder();

    // 3) Upstream SSE chunklarını doğrudan client'a ilet + metni biriktir
    for await (const chunk of upstream.body) {
      if (clientClosed) break;

      // chunk'ı olduğu gibi client'a yaz (typing effect)
      res.write(chunk);

      // Aynı anda parse etmeye çalışalım (handoff için)
      const piece = decoder.decode(chunk, { stream: true });
      buffer += piece;

      // satırlara böl (SSE: "event:" / "data:" satırları)
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // son satır incomplete olabilir

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const evt = JSON.parse(dataStr);
          // Assistants v2 stream: delta içindeki text parçalarını yakalamaya çalış
          // Ör: evt.delta?.content?.[i]?.text?.value
          if (evt?.delta?.content && Array.isArray(evt.delta.content)) {
            for (const c of evt.delta.content) {
              if (c?.type === "text" && c?.text?.value) {
                accText += c.text.value;
              }
            }
          }
          // Bazı event tiplerinde tamamlanmış mesaj da gelebilir:
          // evt?.message?.content[..].text?.value  vs. onları da topla
          if (evt?.message?.content && Array.isArray(evt.message.content)) {
            for (const c of evt.message.content) {
              if (c?.type === "text" && c?.text?.value) {
                accText += c.text.value;
              }
            }
          }
        } catch (_e) {
          // JSON parse edilemeyen satırlar olabilir, atla
        }
      }
    }

    // 4) Stream bitti: accText içinden handoff'ı çıkar, mail at, kullanıcıya görünmesin
    try {
      const handoff = extractHandoff(accText);
      if (handoff) {
        await sendHandoffEmail(handoff);
        console.log(`[handoff][stream] emailed: ${handoff.kind}`);
      }
    } catch (e) {
      console.error("[handoff][stream] email failed:", e);
    }

    // Bitiş
    try { res.end(); } catch {}
  } catch (e) {
    console.error("stream_failed:", e);
    // SSE hata mesajı
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e) })}\n\n`);
      res.end();
    } catch {}
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
