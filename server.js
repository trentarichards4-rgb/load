// server.js
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { google } = require("googleapis");

// =======================
// CONFIG
// =======================
const PORT = 3000;

// Put your OAuth credentials here (Google Cloud -> Credentials -> OAuth Client ID "Web application")
const CLIENT_ID = "271171810325-ncjnuqgveu74j4kkm09vmq9a8mr714c6.apps.googleusercontent.com";
const CLIENT_SECRET = "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";

// MUST match exactly the Redirect URI in your Google Cloud OAuth client:
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

// Token persistence file
const TOKEN_PATH = path.join(__dirname, "tokens.json");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

// =======================
// APP INIT
// =======================
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));

// ✅ Serve your frontend from /public so http://localhost:3000 works
app.use(express.static(path.join(__dirname, "public")));

// ✅ Optional but helpful: force "/" to return index.html (prevents Cannot GET /)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// Load tokens if present
let tokens = null;
try {
  if (fs.existsSync(TOKEN_PATH)) {
    tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oauth2Client.setCredentials(tokens);
    console.log("✅ Loaded tokens from tokens.json");
  } else {
    console.log("⚠️ No tokens.json found yet. Visit /auth to connect Google.");
  }
} catch (e) {
  console.log("⚠️ Could not read tokens.json:", e.message);
}

function ensureAuthed(res) {
  if (!tokens) {
    res.status(401).send("Not authenticated. Visit http://localhost:3000/auth first.");
    return false;
  }
  oauth2Client.setCredentials(tokens);
  return true;
}

function calendarClient() {
  return google.calendar({ version: "v3", auth: oauth2Client });
}

// =======================
// AUTH ROUTES
// =======================
app.get("/auth", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code in callback.");

    const { tokens: newTokens } = await oauth2Client.getToken(code);
    tokens = newTokens;
    oauth2Client.setCredentials(tokens);

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("✅ OAuth success. Tokens saved to tokens.json");
    console.log("Scopes on token:", tokens.scope);

    res.send("Authentication successful. You can close this window.");
  } catch (e) {
    console.error("OAuth callback error:", e);
    res.status(500).send("OAuth callback error: " + e.message);
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

// =======================
// CALENDAR LIST
// =======================
app.get("/list-calendars", async (req, res) => {
  if (!ensureAuthed(res)) return;

  try {
    const cal = calendarClient();
    const resp = await cal.calendarList.list();
    const items = (resp.data.items || []).map((c) => ({
      id: c.id,
      summary: c.summary,
      primary: !!c.primary,
      accessRole: c.accessRole,
    }));
    res.json(items);
  } catch (e) {
    console.error("List calendars error:", e);
    res.status(500).send(e.message);
  }
});

// =======================
// EVENTS IMPORT
// =======================
app.get("/events", async (req, res) => {
  if (!ensureAuthed(res)) return;

  try {
    const cal = calendarClient();
    const timeMin = req.query.timeMin;
    const timeMax = req.query.timeMax;
    const calendarIdParam = req.query.calendarId || "all";

    if (!timeMin || !timeMax) {
      return res.status(400).send("Missing timeMin/timeMax query params (ISO).");
    }

    let calendarIds = [];
    if (calendarIdParam === "all") {
      const list = await cal.calendarList.list();
      calendarIds = (list.data.items || []).map((c) => c.id);
    } else {
      calendarIds = [calendarIdParam];
    }

    const out = [];

    for (const calendarId of calendarIds) {
      let pageToken = undefined;

      do {
        const resp = await cal.events.list({
          calendarId,
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          maxResults: 2500,
          pageToken,
        });

        (resp.data.items || []).forEach((ev) => {
          if (!ev || ev.status === "cancelled") return;

          const start = ev.start?.dateTime || ev.start?.date;
          const end = ev.end?.dateTime || ev.end?.date;
          if (!start || !end) return;

          out.push({
            calendarId,
            id: ev.id,
            summary: ev.summary || "",
            start,
            end,
            status: ev.status,
          });
        });

        pageToken = resp.data.nextPageToken;
      } while (pageToken);
    }

    res.json(out);
  } catch (e) {
    console.error("Events import error:", e);
    res.status(500).send(e.message);
  }
});

// =======================
// EVENT CRUD
// =======================
app.post("/create-event", async (req, res) => {
  if (!ensureAuthed(res)) return;

  try {
    const cal = calendarClient();
    const calendarId = req.body.calendarId || "primary";

    if (!req.body.summary || !req.body.start || !req.body.end) {
      return res.status(400).send("Missing required fields: summary, start, end");
    }

    const response = await cal.events.insert({
      calendarId,
      requestBody: req.body,
    });

    res.json(response.data);
  } catch (e) {
    console.error("Create event error:", e);
    res.status(500).send(e.message);
  }
});

app.put("/update-event/:id", async (req, res) => {
  if (!ensureAuthed(res)) return;

  try {
    const cal = calendarClient();
    const calendarId = req.query.calendarId || "primary";
    const eventId = req.params.id;

    const response = await cal.events.update({
      calendarId,
      eventId,
      requestBody: req.body,
    });

    res.json(response.data);
  } catch (e) {
    console.error("Update event error:", e);
    res.status(500).send(e.message);
  }
});

app.delete("/delete-event/:id", async (req, res) => {
  if (!ensureAuthed(res)) return;

  try {
    const cal = calendarClient();
    const calendarId = req.query.calendarId || "primary";
    const eventId = req.params.id;

    await cal.events.delete({ calendarId, eventId });
    res.send("Deleted");
  } catch (e) {
    console.error("Delete event error:", e);
    res.status(500).send(e.message);
  }
});

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🔐 Authenticate at: http://localhost:${PORT}/auth`);
});