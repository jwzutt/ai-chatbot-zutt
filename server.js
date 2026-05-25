import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import multer from "multer";
import fs from "fs";
import path from "path";
import axios from "axios";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import twilio from "twilio";

import { fileURLToPath } from "url";

dotenv.config();

/* ===================================== */
/* PATH SETUP */
/* ===================================== */

const __filename =
  fileURLToPath(import.meta.url);

const __dirname =
  path.dirname(__filename);

/* ===================================== */
/* CONFIG */
/* ===================================== */

const config = JSON.parse(

  fs.readFileSync(

    path.join(
      __dirname,
      "config.json"
    ),

    "utf8"

  )

);

/* ===================================== */
/* EXPRESS */
/* ===================================== */

const app = express();

app.use(cors());

app.use(express.json());

app.use(

  express.static(

    path.join(
      __dirname,
      "public"
    )

  )

);

/* ===================================== */
/* ROOT */
/* ===================================== */

app.get("/", (req, res) => {

  res.sendFile(

    path.join(
      __dirname,
      "public",
      "index.html"
    )

  );

});

/* ===================================== */
/* OPENAI */
/* ===================================== */

const openai = new OpenAI({

  apiKey:
    process.env.OPENAI_API_KEY

});

/* ===================================== */
/* TWILIO */
/* ===================================== */

const twilioEnabled =

  process.env.TWILIO_ACCOUNT_SID &&

  process.env.TWILIO_AUTH_TOKEN &&

  process.env.TWILIO_PHONE_NUMBER &&

  process.env.BUSINESS_PHONE_NUMBER;

const twilioClient =
  twilioEnabled

    ? twilio(

        process.env.TWILIO_ACCOUNT_SID,

        process.env.TWILIO_AUTH_TOKEN

      )

    : null;

/* ===================================== */
/* PATHS */
/* ===================================== */

const uploadsDir =
  path.join(
    __dirname,
    "uploads"
  );

const knowledgeDir =
  path.join(
    __dirname,
    "knowledge"
  );

const analyticsPath =
  path.join(
    __dirname,
    "analytics.json"
  );

/* ===================================== */
/* ENSURE DIRECTORIES */
/* ===================================== */

if (!fs.existsSync(uploadsDir)) {

  fs.mkdirSync(uploadsDir);
}

if (!fs.existsSync(knowledgeDir)) {

  fs.mkdirSync(knowledgeDir);
}

/* ===================================== */
/* MULTER */
/* ===================================== */

const upload = multer({

  dest: uploadsDir

});

/* ===================================== */
/* ANALYTICS */
/* ===================================== */

function readAnalytics() {

  try {

    return JSON.parse(

      fs.readFileSync(
        analyticsPath,
        "utf8"
      )

    );

  } catch {

    return {

      conversations: 0,

      leads: 0,

      newsletterSubscribers: 0,

      messages: []

    };
  }
}

function writeAnalytics(data) {

  fs.writeFileSync(

    analyticsPath,

    JSON.stringify(
      data,
      null,
      2
    )

  );
}

function trackConversation(message) {

  const analytics =
    readAnalytics();

  analytics.conversations += 1;

  analytics.messages.push({

    message,

    timestamp:
      new Date()
        .toISOString()

  });

  writeAnalytics(
    analytics
  );
}

function trackLead() {

  const analytics =
    readAnalytics();

  analytics.leads += 1;

  writeAnalytics(
    analytics
  );
}

function trackNewsletterSubscriber() {

  const analytics =
    readAnalytics();

  analytics.newsletterSubscribers += 1;

  writeAnalytics(
    analytics
  );
}

/* ===================================== */
/* KNOWLEDGE BASE */
/* ===================================== */

function loadKnowledgeBase() {

  try {

    const files =
      fs.readdirSync(
        knowledgeDir
      );

    let knowledge = "";

    files.forEach(file => {

      const filePath =
        path.join(
          knowledgeDir,
          file
        );

      try {

        const content =
          fs.readFileSync(
            filePath,
            "utf8"
          );

        knowledge +=
          "\n\n" + content;

      } catch (error) {

        console.log(
          `Skipped ${file}`
        );
      }

    });

    return knowledge
      .replace(/\s+/g, " ")
      .slice(0, 15000);

  } catch {

    return "";
  }
}

function findRelevantKnowledge(
  knowledge,
  question
) {

  const chunks =
    knowledge.split("\n");

  const words =
    question
      .toLowerCase()
      .split(" ");

  const relevant =
    chunks.filter(chunk => {

      const lower =
        chunk.toLowerCase();

      return words.some(word =>
        lower.includes(word)
      );

    });

  return relevant
    .slice(0, 20)
    .join("\n");
}

/* ===================================== */
/* HUBSPOT */
/* ===================================== */

async function createHubspotLead(data) {

  if (

    !config.enableHubspot ||

    !process.env.HUBSPOT_ACCESS_TOKEN

  ) {

    return;
  }

  try {

    await axios.post(

      "https://api.hubapi.com/crm/v3/objects/contacts",

      {

        properties: {

          firstname:
            data.name || "Website",

          lastname:
            "Lead",

          email:
            data.email || "",

          phone:
            data.phone || ""

        }

      },

      {

        headers: {

          Authorization:
            `Bearer ${process.env.HUBSPOT_ACCESS_TOKEN}`,

          "Content-Type":
            "application/json"

        }

      }

    );

  } catch (error) {

    console.error(
      "HubSpot Error:",
      error.response?.data ||
      error.message
    );
  }
}

/* ===================================== */
/* SMS */
/* ===================================== */

async function sendSMS(message) {

  if (

    !config.enableTwilio ||

    !twilioEnabled

  ) {

    return;
  }

  try {

    await twilioClient
      .messages
      .create({

        body: message,

        from:
          process.env.TWILIO_PHONE_NUMBER,

        to:
          process.env.BUSINESS_PHONE_NUMBER

      });

  } catch (error) {

    console.error(
      "Twilio Error:",
      error.message
    );
  }
}

/* ===================================== */
/* GOOGLE SHEETS */
/* ===================================== */

async function logToGoogleSheets(data) {

  if (

    !config.enableGoogleSheets ||

    !process.env.GOOGLE_SHEETS_WEBHOOK

  ) {

    return;
  }

  try {

    await axios.post(

      process.env.GOOGLE_SHEETS_WEBHOOK,

      data

    );

  } catch (error) {

    console.error(
      "Google Sheets Error:",
      error.message
    );
  }
}

/* ===================================== */
/* NEWSLETTER PROVIDERS */
/* ===================================== */

async function subscribeNewsletter(
  email
) {

  const provider =
    config.newsletterProvider;

  if (
    provider === "googleSheets"
  ) {

    await logToGoogleSheets({

      name:
        "Newsletter Subscriber",

      email,

      message:
        "Newsletter Signup"

    });

    return;
  }

  if (
    provider === "mailchimp"
  ) {

    console.log(
      "Mailchimp not setup yet"
    );

    return;
  }

  if (
    provider === "hubspot"
  ) {

    console.log(
      "HubSpot newsletter not setup yet"
    );

    return;
  }
}

/* ===================================== */
/* CONFIG ROUTE */
/* ===================================== */

app.get("/config", (req, res) => {

  res.json({

    businessName:
      config.businessName,

    primaryColor:
      config.primaryColor,

    secondaryColor:
      config.secondaryColor,

    welcomeMessage:
      config.welcomeMessage,

    calendlyUrl:
      config.calendlyUrl,

    enableCalendly:
      config.enableCalendly,

    googleReviewLink:
      config.googleReviewLink,

    enableReviewRequests:
      config.enableReviewRequests,

    enableNewsletter:
      config.enableNewsletter,

    newsletterProvider:
      config.newsletterProvider,

    stripePaymentLink:
      config.stripePaymentLink,

    enablePayments:
      config.enablePayments

  });

});

/* ===================================== */
/* CHAT */
/* ===================================== */

app.post("/chat", async (req, res) => {

  try {

    const messages =
      req.body.messages || [];

    const latestMessage =
      messages[
        messages.length - 1
      ]?.content || "";

    trackConversation(
      latestMessage
    );

    const knowledge =
      loadKnowledgeBase();

    const relevantKnowledge =
      findRelevantKnowledge(
        knowledge,
        latestMessage
      );

    const completion =
      await openai.chat.completions.create({

        model:
          "gpt-4.1-mini",

        messages: [

          {

            role: "system",

            content: `

You are a conversational virtual assistant for the business.

Be conversational, concise, and helpful.

Rules:
- Keep responses short and natural
- Avoid giant blocks of text
- Avoid excessive bullet points
- Ask only one question at a time
- Help users directly inside the chat
- Never tell users to use website forms
- Sound human and modern

If users need:
- help
- estimates
- services
- appointments
- consultations
- pricing

begin conversational lead capture naturally.

If users ask about:
- newsletters
- updates
- promotions

offer to sign them up.

If users ask about:
- payments
- deposits
- invoices

offer payment assistance.

Business Knowledge:

${relevantKnowledge}

`

          },

          ...messages

        ]

      });

    const reply =
      completion
        .choices[0]
        .message
        .content;

    res.json({

      reply

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      reply:
        "Something went wrong."

    });

  }

});

/* ===================================== */
/* LEADS */
/* ===================================== */

app.post("/lead", async (req, res) => {

  try {

    const {

      name,
      email,
      phone,
      message

    } = req.body;

    await createHubspotLead({

      name,
      email,
      phone,
      message

    });

    await sendSMS(`

New Website Lead

Name:
${name}

Email:
${email}

Phone:
${phone}

Message:
${message}

`);

    await logToGoogleSheets({

      name,
      email,
      phone,
      message

    });

    trackLead();

    res.json({

      success: true

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      error:
        "Lead capture failed"

    });

  }

});

/* ===================================== */
/* NEWSLETTER */
/* ===================================== */

app.post("/newsletter", async (req, res) => {

  try {

    const { email } =
      req.body;

    if (!email) {

      return res.status(400)
        .json({

          error:
            "Email required"

        });
    }

    trackNewsletterSubscriber();

    await subscribeNewsletter(
      email
    );

    res.json({

      success: true

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      error:
        "Newsletter signup failed"

    });

  }

});

/* ===================================== */
/* WEBSITE TRAINING */
/* ===================================== */

app.post("/train-website", async (req, res) => {

  try {

    const { url } =
      req.body;

    const response =
      await axios.get(url);

    const $ =
      cheerio.load(
        response.data
      );

    $("script").remove();
    $("style").remove();

    const text =
      $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();

    const filePath =
      path.join(

        knowledgeDir,

        `website-${Date.now()}.txt`

      );

    fs.writeFileSync(
      filePath,
      text
    );

    res.json({

      success: true

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({

      error:
        "Website training failed"

    });

  }

});

/* ===================================== */
/* FILE UPLOAD */
/* ===================================== */

app.post(

  "/upload",

  upload.single("file"),

  async (req, res) => {

    try {

      const file =
        req.file;

      if (!file) {

        return res.status(400)
          .json({

            error:
              "No file uploaded"

          });
      }

      const ext =
        path.extname(
          file.originalname
        ).toLowerCase();

      let text = "";

      if (ext === ".txt") {

        text =
          fs.readFileSync(
            file.path,
            "utf8"
          );

      } else if (ext === ".docx") {

        const result =
          await mammoth
            .extractRawText({

              path:
                file.path

            });

        text =
          result.value;
      }

      const knowledgePath =
        path.join(

          knowledgeDir,

          `${Date.now()}-${file.originalname}.txt`

        );

      fs.writeFileSync(

        knowledgePath,

        text

      );

      res.json({

        success: true

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({

        error:
          "Upload failed"

      });

    }

  }

);

/* ===================================== */
/* DASHBOARD */
/* ===================================== */

app.get("/dashboard", (req, res) => {

  const password =
    req.query.password;

  if (

    password !==
    process.env.DASHBOARD_PASSWORD

  ) {

    return res
      .status(401)
      .send("Unauthorized");
  }

  const analytics =
    readAnalytics();

  res.send(`

<html>

<head>

<title>
Dashboard
</title>

<style>

body {

  font-family:
    Arial,
    sans-serif;

  padding: 40px;

  background:
    #f5f7fb;
}

.card {

  background: white;

  padding: 24px;

  border-radius: 18px;

  margin-bottom: 20px;

  box-shadow:
    0 2px 10px rgba(0,0,0,0.08);
}

.metric {

  font-size: 42px;

  font-weight: bold;

  margin-top: 10px;
}

.message {

  padding: 12px;

  border-bottom:
    1px solid #eee;
}

</style>

</head>

<body>

<h1>
AI Chatbot Dashboard
</h1>

<div class="card">

  <h2>
    Conversations
  </h2>

  <div class="metric">

    ${analytics.conversations}

  </div>

</div>

<div class="card">

  <h2>
    Leads Captured
  </h2>

  <div class="metric">

    ${analytics.leads}

  </div>

</div>

<div class="card">

  <h2>
    Newsletter Subscribers
  </h2>

  <div class="metric">

    ${analytics.newsletterSubscribers || 0}

  </div>

</div>

<div class="card">

  <h2>
    Recent Messages
  </h2>

  ${analytics.messages

    .slice(-20)

    .reverse()

    .map(msg => `

      <div class="message">

        ${msg.message}

        <br><br>

        <small>

          ${msg.timestamp}

        </small>

      </div>

    `)

    .join("")
  }

</div>

</body>

</html>

`);

});

/* ===================================== */
/* START */
/* ===================================== */

const PORT =
  process.env.PORT || 3000;

app.listen(

  PORT,
  "0.0.0.0",

  () => {

    console.log(
      `Server running on port ${PORT}`
    );

  }

);