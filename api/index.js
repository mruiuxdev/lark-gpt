const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");
const { MongoClient } = require("mongodb"); // Example: Using MongoDB with MongoDB Atlas
const { ObjectId } = require("mongodb");

const LARK_APP_ID = process.env.APPID || "";
const LARK_APP_SECRET = process.env.SECRET || "";
const OPENAI_KEY = process.env.KEY || "";
const OPENAI_MODEL = process.env.MODEL || "gpt-3.5-turbo";
const OPENAI_MAX_TOKEN = parseInt(process.env.MAX_TOKEN) || 1024;

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

// Example MongoDB connection setup
let db;

async function connectToDatabase() {
  const uri = process.env.MONGODB_URI;
  const client = new MongoClient(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  try {
    await client.connect();
    db = client.db("your-database-name");
    console.log("Connected to MongoDB");
  } catch (e) {
    console.error("Error connecting to MongoDB", e);
  }
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
    console.error("send message to Lark error", e);
  }
}

async function saveConversation(sessionId, question, answer) {
  const collection = db.collection("msg");

  const msgSize = question.length + answer.length;
  const result = await collection.insertOne({
    sessionId,
    question,
    answer,
    msgSize,
    createdAt: new Date(),
  });

  if (result) {
    await discardConversation(sessionId);
  }
}

async function discardConversation(sessionId) {
  const collection = db.collection("msg");

  let totalSize = 0;
  const cursor = collection.find({ sessionId }).sort({ createdAt: -1 });

  await cursor.forEach(async (doc) => {
    totalSize += doc.question.length + doc.answer.length;

    if (totalSize > OPENAI_MAX_TOKEN) {
      await collection.deleteOne({ _id: ObjectId(doc._id) });
    }
  });
}

async function clearConversation(sessionId) {
  const collection = db.collection("msg");
  await collection.deleteMany({ sessionId });
}

async function getOpenAIReply(prompt) {
  const data = JSON.stringify({
    model: OPENAI_MODEL,
    messages: prompt,
  });

  const config = {
    method: "post",
    maxBodyLength: Infinity,
    url: "https://api.openai.com/v1/chat/completions",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    data: data,
    timeout: 50000,
  };

  try {
    const response = await axios(config);

    if (response.status === 429) {
      return "Too many questions. Please wait and try again later.";
    }

    return response.data.choices[0].message.content.replace("\n\n", "");
  } catch (e) {
    console.error("OpenAI request error", e);
    return "This question is too difficult. Please ask the owner.";
  }
}

async function handleReply(userInput, sessionId, messageId, eventId) {
  const question = userInput.text.replace("@_user_1", "").trim();

  if (question.startsWith("/")) {
    // Handle commands
    switch (question) {
      case "/help":
        await cmdHelp(messageId);
        break;
      case "/clear":
        await cmdClear(sessionId, messageId);
        break;
      default:
        await cmdHelp(messageId);
        break;
    }

    return { code: 0 };
  }

  const prompt = await buildConversation(sessionId, question);
  const openaiResponse = await getOpenAIReply(prompt);

  await saveConversation(sessionId, question, openaiResponse);
  await reply(messageId, openaiResponse);

  // Update content to the event record
  const collection = db.collection("event");
  await collection.updateOne(
    { event_id: eventId },
    { $set: { content: userInput.text } }
  );

  return { code: 0 };
}

module.exports = async function (params, context) {
  if (params.type === "url_verification") {
    return {
      challenge: params.challenge,
    };
  }

  if (!db) {
    await connectToDatabase();
  }

  if (params.header.event_type === "im.message.receive_v1") {
    const eventId = params.header.event_id;
    const messageId = params.event.message.message_id;
    const chatId = params.event.message.chat_id;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = chatId + senderId;

    // Process event only once
    const collection = db.collection("event");
    const count = await collection.countDocuments({ event_id: eventId });

    if (count !== 0) {
      console.log("Skip repeat event");
      return { code: 1 };
    }

    await collection.insertOne({ event_id: eventId });

    // Replay in private chat
    if (params.event.message.chat_type === "p2p") {
      if (params.event.message.message_type !== "text") {
        await reply(messageId, "Only text format is supported.");
        return { code: 0 };
      }

      const userInput = JSON.parse(params.event.message.content);
      return await handleReply(userInput, sessionId, messageId, eventId);
    }

    // Group chat process
    if (params.event.message.chat_type === "group") {
      const userInput = JSON.parse(params.event.message.content);
      return await handleReply(userInput, sessionId, messageId, eventId);
    }
  }

  console.log("Return without other logs");
  return { code: 2 };
};
