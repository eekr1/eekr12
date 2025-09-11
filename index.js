import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";


dotenv.config();

const app = express();



app.use(cors());
app.use(express.json());
app.get("/health", (_req,res) => res.json({ ok: true, ts: Date.now() }));
app.use((req,res,next)=>{
  const t = Date.now();
  res.on("finish", ()=> {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now()-t}ms`);
  });
  next();
});
app.use(express.static("public"));
app.get("/", (_req,res)=> res.redirect("/test.html"));



const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID   = process.env.ASSISTANT_ID;
const OPENAI_BASE    = process.env.OPENAI_BASE || "https://api.openai.com/v1";
const PORT           = process.env.PORT || 8787;

if (!OPENAI_API_KEY || !ASSISTANT_ID) {
  console.error("Missing OPENAI_API_KEY or ASSISTANT_ID in .env");
  process.exit(1);
}

// Yardımcı: OpenAI çağrısı
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

// 1) Thread oluştur
app.post("/api/chat/init", async (req, res) => {
  try {
    const thread = await openAI("/threads", { method: "POST", body: {} });
    return res.json({ threadId: thread.id });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "init_failed", detail: String(e) });
  }
});

// 2) Mesaj gönder + run başlat + poll + yanıtı getir
app.post("/api/chat/message", async (req, res) => {
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
    let runId = run.id;
    const started = Date.now();
    const TIMEOUT_MS = 60_000; // 60 sn

    while (runStatus !== "completed") {
      if (Date.now() - started > TIMEOUT_MS) {
        throw new Error("Run polling timeout");
      }
      await new Promise(r => setTimeout(r, 1200));
      const polled = await openAI(`/threads/${threadId}/runs/${runId}`);
      runStatus = polled.status;

      if (runStatus === "failed" || runStatus === "cancelled" || runStatus === "expired") {
        throw new Error(`Run status: ${runStatus}`);
      }
      // tool_handling gerekirse burada eklenir (şimdilik yok / file_search pasif kullanım)
    }

    // 2.d) Mesajları çek (en yeni asistan mesajını al)
    const msgs = await openAI(`/threads/${threadId}/messages?order=desc&limit=10`);
    const assistantMsg = (msgs.data || []).find(m => m.role === "assistant");

    // İçerik metnini ayıkla (text parçaları)
    let text = "";
    if (assistantMsg && assistantMsg.content) {
      for (const part of assistantMsg.content) {
        if (part.type === "text" && part.text?.value) {
          text += part.text.value + "\n";
        }
      }
      text = text.trim();
    }

    return res.json({
      status: "ok",
      threadId,
      message: text || "(Yanıt metni bulunamadı)",
      raw: assistantMsg || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "message_failed", detail: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
