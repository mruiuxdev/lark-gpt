const express = require("express");
const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");
const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config({});

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.APPID || "";
const LARK_APP_SECRET = process.env.SECRET || "";
const OPENAI_MAX_TOKEN = process.env.MAX_TOKEN || 1024;

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("Database connected successfully"))
  .catch((err) => console.log(err));

const eventSchema = new mongoose.Schema({
  event_id: { type: String, unique: true },
  content: String,
});

const msgSchema = new mongoose.Schema({
  sessionId: String,
  question: String,
  answer: String,
  msgSize: Number,
  createdAt: { type: Date, default: Date.now },
});

const Event = mongoose.model("Event", eventSchema);
const Msg = mongoose.model("Msg", msgSchema);

app.use(express.json());

function logger(param) {
  console.error(`[CF]`, param);
}

async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: {
        message_id: messageId,
      },
      data: {
        content: JSON.stringify({
          text: content,
        }),
        msg_type: "text",
      },
    });
  } catch (e) {
    logger("send message to Lark error", e, messageId, content);
  }
}

async function buildConversation(sessionId, question) {
  const prompt = [];
  const messages = await Msg.find({ sessionId }).sort({ createdAt: 1 });
  messages.forEach((row) => {
    prompt.push({ role: "user", content: row.question });
    prompt.push({ role: "assistant", content: row.answer });
  });
  prompt.push({ role: "user", content: question });
  return prompt;
}

async function saveConversation(sessionId, question, answer) {
  if (!question || !answer) {
    logger(
      "Invalid question or answer. Question:",
      question,
      "Answer:",
      answer
    );
    return;
  }

  const msgSize = question.length + answer.length;
  await new Msg({ sessionId, question, answer, msgSize }).save();
  discardConversation(sessionId);
}

async function discardConversation(sessionId) {
  const messages = await Msg.find({ sessionId }).sort({ createdAt: -1 });
  let totalSize = 0;
  const countList = [];

  messages.forEach((row) => {
    totalSize += row.msgSize;
    countList.push({
      msgId: row._id,
      totalSize,
    });
  });

  for (const c of countList) {
    if (c.totalSize > OPENAI_MAX_TOKEN) {
      await Msg.deleteOne({ _id: c.msgId });
    }
  }
}

async function clearConversation(sessionId) {
  await Msg.deleteMany({ sessionId });
}

async function cmdProcess(cmdParams) {
  switch (cmdParams && cmdParams.action) {
    case "/help":
      await cmdHelp(cmdParams.messageId);
      break;
    case "/clear":
      await cmdClear(cmdParams.sessionId, cmdParams.messageId);
      break;
    default:
      await cmdHelp(cmdParams.messageId);
      break;
  }
  return { code: 0 };
}

async function cmdHelp(messageId) {
  const helpText = `Lark GPT manpages

Usage:
    /clear    remove conversation history for get a new, clean, bot context.
    /help     get more help message
  `;
  await reply(messageId, helpText);
}

async function cmdClear(sessionId, messageId) {
  clearConversation(sessionId);
  await reply(messageId, "✅ All history removed");
}

async function query(data) {
  try {
    const response = await axios.post(
      "https://chatflow-aowb.onrender.com/api/v1/prediction/a6dfcf0e-8c63-4515-8f71-b41abaa45bbe",
      data,
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error("Error querying custom API:", error);
    throw new Error("Failed to query the custom API");
  }
}

async function getCustomAPIReply(prompt) {
  try {
    const data = { question: prompt.map((p) => p.content).join(" ") };
    const response = await query(data);
    return response.answer;
  } catch (e) {
    logger(e);
    return "This question is too difficult, you may ask my owner.";
  }
}

async function doctor() {
  if (LARK_APP_ID === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置 Lark 应用的 AppID，请检查 & 部署后重试",
        en_US: "Here is no Lark APP id, please check & re-Deploy & call again",
      },
    };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return {
      code: 1,
      message: {
        zh_CN:
          "你配置的 Lark 应用的 AppID 是错误的，请检查后重试。 Lark 应用的 APPID 以 cli_ 开头。",
        en_US:
          "Your Lark App ID is Wrong, Please Check and call again. Lark APPID must Start with cli",
      },
    };
  }
  if (LARK_APP_SECRET === "") {
    return {
      code: 1,
      message: {
        zh_CN: "你没有配置 Lark 应用的 Secret，请检查 & 部署后重试",
        en_US:
          "Here is no Lark APP Secret, please check & re-Deploy & call again",
      },
    };
  }
  return {
    code: 0,
    message: {
      zh_CN:
        "✅ 配置成功，接下来你可以在 Lark 应用当中使用机器人来完成你的工作。",
      en_US:
        "✅ Configuration is correct, you can use this bot in your Lark App",
    },
    meta: {
      LARK_APP_ID,
      OPENAI_MAX_TOKEN,
    },
  };
}

async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "");
  logger("question: " + question);
  const action = question.trim();
  if (action.startsWith("/")) {
    return await cmdProcess({ action, sessionId, messageId });
  }
  const prompt = await buildConversation(sessionId, question);
  const apiResponse = await getCustomAPIReply(prompt);
  await saveConversation(sessionId, question, apiResponse);
  await reply(messageId, apiResponse);

  await new Event({ event_id: eventId, content: userInput.text }).save();
  return { code: 0 };
}

app.post("/webhook", async (req, res) => {
  const params = req.body;
  if (params.encrypt) {
    logger("user enable encrypt key");
    return res.json({
      code: 1,
      message: {
        zh_CN: "你配置了 Encrypt Key，请关闭该功能。",
        en_US: "You have open Encrypt Key Feature, please close it.",
      },
    });
  }
  if (params.type === "url_verification") {
    logger("deal url_verification");
    return res.json({
      challenge: params.challenge,
    });
  }
  if (!params.header || req.query.debug) {
    logger("enter doctor");
    const doc = await doctor();
    return res.json(doc);
  }
  if (params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    const event = await Event.findOne({ event_id: eventId });
    if (event) {
      logger("skip repeat event");
      return res.json({ code: 1 });
    }

    await new Event({ event_id: eventId }).save();

    if (params.event.message.chat_type === "p2p") {
      if (params.event.message.message_type != "text") {
        await reply(messageId, "Not support other format question, only text.");
        logger("skip and reply not support");
        return res.json({ code: 0 });
      }
      const userInput = JSON.parse(params.event.message.content);
      const result = await handleReply(
        userInput,
        sessionId,
        messageId,
        eventId
      );
      return res.json(result);
    }

    if (params.event.message.chat_type === "group") {
      const userInput = JSON.parse(params.event.message.content);
      const result = await handleReply(
        userInput,
        sessionId,
        messageId,
        eventId
      );
      return res.json(result);
    }
  }

  logger("return without other log");
  return res.json({ code: 2 });
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello, world!" });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
