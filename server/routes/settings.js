import express from "express";
import { getSlackNotifySettings, setSlackNotifySettings } from "../db.js";

const router = express.Router();

router.get("/slack-notify", async (req, res) => {
  try {
    const settings = await getSlackNotifySettings();
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ error: "Failed to load settings", detail: error.message });
  }
});

router.put("/slack-notify", async (req, res) => {
  try {
    const { notifyCategories, subjectContainsPhrases } = req.body || {};
    const settings = await setSlackNotifySettings({
      notifyCategories,
      subjectContainsPhrases
    });
    return res.json(settings);
  } catch (error) {
    return res.status(500).json({ error: "Failed to save settings", detail: error.message });
  }
});

export default router;
