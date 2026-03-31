import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import authRoutes from "./routes/auth.js";
import emailRoutes from "./routes/emails.js";
import settingsRoutes from "./routes/settings.js";
import slackRoutes, { handleSlackActions, handleSlackEvents } from "./routes/slack.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load all present files (repo root → inboxpilot → server). Later wins so local overrides work.
const envPaths = [
  path.join(__dirname, "..", "..", ".env"),
  path.join(__dirname, "..", ".env"),
  path.join(__dirname, ".env")
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

fs.mkdirSync(path.resolve("data"), { recursive: true });

function slackCaptureRaw(req, res, buf) {
  req.slackRawBody = buf.toString("utf8");
}

/** Parse Slack Events JSON after express.raw — signature must use the same raw bytes as Slack. */
function slackEventsParseJson(req, res, next) {
  try {
    const raw = req.slackRawBody ?? (Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
    if (!raw) return res.status(400).send("Empty body");
    req.slackJson = JSON.parse(raw);
    next();
  } catch {
    return res.status(400).send("Bad JSON");
  }
}

app.use(cors());

// Accept any Content-Type so Slack's POST always has a body + raw string for signing.
app.post(
  "/api/slack/events",
  express.raw({ type: "*/*", limit: "2mb", verify: slackCaptureRaw }),
  slackEventsParseJson,
  handleSlackEvents
);
app.post(
  "/api/slack/actions",
  express.urlencoded({ extended: true, limit: "2mb", verify: slackCaptureRaw }),
  handleSlackActions
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/health", (req, res) => res.json({ ok: true }));
app.use("/auth", authRoutes);
app.use("/api/emails", emailRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/slack", slackRoutes);

app.use((err, req, res, next) => {
  return res.status(500).json({ error: "Unexpected server error", detail: err.message });
});

app.listen(PORT, () => {
  console.log(`InboxPilot server running on http://localhost:${PORT}`);
});
