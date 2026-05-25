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

dotenv.config();

/* ===================================== */
/* CONFIG */
/* ===================================== */

const config = JSON.parse(

  fs.readFileSync(
    "config.json",
    "utf8"
  )

);

const app = express();

app.use(cors());
app.use(express.json());

/* ===================================== */
/* ALLOW IFRAME EMBEDDING */
/* ===================================== */

app.use((req, res, next) => {

  res.setHeader(
    "X-Frame-Options",
    "ALLOWALL"
  );

  next();
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
  path.join(process.cwd(), "uploads");

const knowledgeDir =
  path.join(process.cwd(), "knowledge");

const analyticsPath =
  path.join(process.cwd(), "analytics.json");

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
/* STATIC */
/* ===================================== */

app.use(
  express.static("public")
);

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
/* LOAD KNOWLEDGE */
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

      const content =
        fs.readFileSync(
          filePath,
          "utf8"
        );

      knowledge +=
        "\n\n" + content;
    });

    return knowledge
      .replace(/\s+/g, " ")
      .slice(0, 15000);

  } catch (error) {

    console.error(
      "Knowledge Error:",
      error.message
    );

    return "";
  }
}

/* ===================================== */
/* FIND RELEVANT KNOWLEDGE */
/* ===================================== */

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

    console.log(
      "HubSpot not configured"
    );

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
            data.phone || "",

          company:
            data.company || "",

          website:
            data.website || ""

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

    console.log(
      "HubSpot lead created"
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

    console.log(
      "Twilio not configured"
    );

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

    console.log(
      "SMS sent"
    );

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

    console.log(
      "Google Sheets not configured"
    );

    return;
  }

  try {

    await axios.post(

      process.env.GOOGLE_SHEETS_WEBHOOK,

      data

    );

    console.log(
      "Logged to Google Sheets"
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

  /* ========================= */
  /* GOOGLE SHEETS */
  /* ========================= */

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

    console.log(

      "Newsletter subscriber saved to Google Sheets"

    );

    return;
  }

  /* ========================= */
  /* MAILCHIMP */
  /* ========================= */

  if (
    provider === "mailchimp"
  ) {

    console.log(
      "Mailchimp integration not setup yet"
    );

    return;
  }

  /* ========================= */
  /* HUBSPOT */
  /* ========================= */

  if (
    provider === "hubspot"
  ) {

    console.log(
      "HubSpot newsletter integration not setup yet"
    );

    return;
  }

  console.log(
    "Unknown newsletter provider"
  );
}

/* ===================================== */
/* CHAT */
/* ===================================== */

app.post(
  "/chat",
  async (req, res) => {

    try {

      const messages =
        req.body.messages || [];

      const knowledge =
        loadKnowledgeBase();

      const latestMessage =
        messages[
          messages.length - 1
        ]?.content || "";

      trackConversation(
        latestMessage
      );

      const relevantKnowledge =
        findRelevantKnowledge(
          knowledge,
          latestMessage
        );

      const completion =
        await openai.chat.completions.create({

          model: "gpt-4.1-mini",

          messages: [

            {
              role: "system",

              content: `

You are a conversational virtual assistant for the business.

Your job is to help website visitors naturally, professionally, and conversationally.

You should sound like a real modern customer support and sales assistant.

IMPORTANT RULES:

- Be conversational and natural
- Keep responses concise
- Avoid giant blocks of text
- Avoid excessive bullet points
- Avoid sounding robotic
- Avoid repeating yourself
- NEVER tell users to "use the website form"
- Collect information naturally inside the chat
- Ask only ONE question at a time
- Sound proactive and helpful
- Keep responses human-like and modern
- Focus on helping users quickly
- Be friendly and confident
- Keep most responses between 1-4 sentences

LEAD CAPTURE RULES:

If users mention:
- needing help
- estimates
- repairs
- appointments
- consultations
- quotes
- services
- pricing
- bookings

begin conversational lead capture naturally.

Gather:
- name
- phone
- email
- service needed
- issue details

BUT:
- only ask ONE question at a time
- do not interrogate users
- keep it conversational

Example:

User:
"I need plumbing help"

Assistant:
"Absolutely — what issue are you experiencing?"

Then continue naturally.

NEWSLETTER RULES:

If users mention:
- newsletters
- updates
- promotions
- announcements
- deals
- offers

offer to sign them up for updates.

PAYMENT RULES:

If users ask about:
- deposits
- invoices
- payments
- booking fees
- consultation fees

you can offer payment assistance.

BOOKING RULES:

If users mention:
- scheduling
- appointments
- consultations
- booking

you can help them book an appointment.

STYLE RULES:

- Avoid overexplaining
- Avoid long lists unless requested
- Avoid markdown formatting unless necessary
- Prioritize conversational UX over perfect formatting
- Sound intelligent but approachable
- Never say you are "just an AI"
- Never refuse basic business assistance
- Guide users naturally toward solutions

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

        error:
          "Chatbot error"

      });
    }
  }
);

/* ===================================== */
/* LEAD */
/* ===================================== */

app.post(
  "/lead",
  async (req, res) => {

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
  }
);

/* ===================================== */
/* NEWSLETTER */
/* ===================================== */

app.post(
  "/newsletter",
  async (req, res) => {

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
  }
);

/* ===================================== */
/* UPLOAD */
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

        text = result.value;
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
/* WEBSITE TRAINING */
/* ===================================== */

app.post(
  "/train-website",
  async (req, res) => {

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
  }
);

/* ===================================== */
/* DASHBOARD AUTH */
/* ===================================== */

function checkDashboardAuth(
  req,
  res,
  next
) {

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

  next();
}

/* ===================================== */
/* DASHBOARD */
/* ===================================== */

app.get(
  "/dashboard",
  checkDashboardAuth,

  (req, res) => {

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
/* CONFIG */
/* ===================================== */

app.get(
  "/config",
  (req, res) => {

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
/* SERVER */
/* ===================================== */

const PORT =
  process.env.PORT || 3000;

app.listen(PORT, () => {

  console.log(
    `Server running at http://localhost:${PORT}`
  );
});