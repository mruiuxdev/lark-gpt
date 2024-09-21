require("dotenv").config();
const lark = require("@larksuiteoapi/node-sdk");
const axios = require("axios");

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";

const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

function logger(param) {
  console.error(`[CF]`, param);
}

async function reply(messageId, content) {
  try {
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text: content }), msg_type: "text" },
    });
  } catch (e) {
    logger("send message to Lark error", e, messageId, content);
  }
}

async function queryFlowiseAI(data) {
  try {
    const response = await axios.post(FLOWISE_API_URL, data, {
      headers: {
        "Content-Type": "application/json",
      },
    });
    return response.data;
  } catch (error) {
    logger("Error querying Flowise AI:", error);
    return "An error occurred while contacting Flowise AI.";
  }
}

async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("question: " + question);

  const data = {
    question: question,
    overrideConfig: {
      // systemMessage: "example",
      maxIterations: 1,
      sessionId: sessionId,
      // memoryKey: "example",
    },
  };

  const flowiseResponse = await queryFlowiseAI(data);
  await reply(messageId, flowiseResponse);
  return { code: 0 };
}

module.exports = async function (params, context) {
  if (params.type === "url_verification") {
    return { challenge: params.challenge };
  }

  if (params.header.event_type === "im.message.receive_v1") {
    const messageId = params.event.message.message_id;
    const userInput = JSON.parse(params.event.message.content);
    const sessionId =
      params.event.message.chat_id + params.event.sender.sender_id.user_id;

    if (
      params.event.message.chat_type === "p2p" ||
      params.event.message.chat_type === "group"
    ) {
      return await handleReply(userInput, sessionId, messageId);
    }
  }

  logger("return without other log");
  return { code: 2 };
};
