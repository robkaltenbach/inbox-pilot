import express from "express";
import { exchangeCodeForTokens, getAuthUrl } from "../services/gmail.js";
import { clearTokens, getTokenRow, getWatchState } from "../db.js";

const router = express.Router();

function getRequestOrigin(req) {
  const origin = req.get("origin");
  if (origin) return origin;
  const referer = req.get("referer");
  if (!referer) return "";
  try {
    return new URL(referer).origin;
  } catch {
    return "";
  }
}

function resolveFrontendUrl(req) {
  const fallback = process.env.FRONTEND_URL || "http://localhost:5173";
  const raw = req.query.frontend || getRequestOrigin(req) || fallback;
  try {
    const url = new URL(raw);
    if (url.hostname !== "localhost") return fallback;
    return url.origin;
  } catch {
    return fallback;
  }
}

router.get("/google", async (req, res) => {
  try {
    const frontend = resolveFrontendUrl(req);
    const state = Buffer.from(JSON.stringify({ frontend }), "utf8").toString("base64url");
    const url = getAuthUrl(state);
    return res.redirect(url);
  } catch (error) {
    return res.status(500).json({ error: "Failed to start Google OAuth", detail: error.message });
  }
});

router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).json({ error: "Missing OAuth code" });
    await exchangeCodeForTokens(code);

    let frontend = process.env.FRONTEND_URL || "http://localhost:5173";
    if (state) {
      try {
        const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
        const candidate = new URL(parsed.frontend);
        if (candidate.hostname === "localhost") frontend = candidate.origin;
      } catch {
        // Keep fallback when state decoding fails.
      }
    }

    return res.redirect(frontend);
  } catch (error) {
    return res.status(500).json({ error: "OAuth callback failed", detail: error.message });
  }
});

router.get("/status", async (req, res) => {
  try {
    const token = await getTokenRow();
    return res.json({ connected: Boolean(token?.access_token) });
  } catch (error) {
    return res.status(500).json({ error: "Unable to check status", detail: error.message });
  }
});

router.get("/connections", async (req, res) => {
  try {
    const [token, watch] = await Promise.all([getTokenRow(), getWatchState()]);
    const connected = Boolean(token?.access_token);
    const inboxes = connected
      ? [
          {
            id: "gmail-primary",
            provider: "gmail",
            label: watch?.email_address || "Connected Gmail inbox",
            watchActive: Boolean(watch?.watch_expiration && Number(watch.watch_expiration) > Date.now()),
            watchExpiration: watch?.watch_expiration || null
          }
        ]
      : [];
    return res.json({ connected, inboxes });
  } catch (error) {
    return res.status(500).json({ error: "Unable to load inbox connections", detail: error.message });
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    await clearTokens();
    return res.json({ ok: true, connected: false });
  } catch (error) {
    return res.status(500).json({ error: "Unable to disconnect Gmail", detail: error.message });
  }
});

export default router;
