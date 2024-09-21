async function queryFlowise(question, sessionId) {
  try {
    // Send question to Flowise API and pass sessionId
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, sessionId }),  // Include sessionId in the request
    });

    const result = await response.json();

    if (result.text) {
      // Check if sessionId is updated in the response
      const newSessionId = result.sessionId || sessionId;

      // Update session history with the latest sessionId and response
      lastSessionMap.set(newSessionId, { question, answer: result.text });

      return { text: result.text, sessionId: newSessionId };  // Return updated sessionId
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question, sessionId);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    // Query Flowise and receive the updated sessionId and response text
    const { text, sessionId: newSessionId } = await queryFlowise(question, sessionId);

    // Update last session with the latest sessionId
    lastSessionMap.set(newSessionId, { question, text });

    // Reply to the user
    return await reply(messageId, text);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

app.post("/webhook", async (req, res) => {
  const { body: params } = req;

  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  if (params.encrypt) {
    return res.json({
      code: 1,
      message: "Encryption is enabled, please disable it.",
    });
  }

  if (!params.header) {
    const configValidation = await validateAppConfig();
    return res.json(configValidation);
  }

  const { event_type: eventType, event_id: eventId } = params.header;

  if (eventType === "im.message.receive_v1") {
    const {
      message_id: messageId,
      chat_id: chatId,
      message_type: messageType,
    } = params.event.message;
    const senderId = params.event.sender.sender_id.user_id;
    const sessionId = `${chatId}${senderId}`;

    if (processedEvents.has(eventId)) {
      return res.json({ code: 0, message: "Duplicate event" });
    }

    processedEvents.add(eventId);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const userInput = JSON.parse(params.event.message.content);

    // Handle the reply and use sessionId
    const result = await handleReply(userInput, sessionId, messageId);

    return res.json(result);
  }

  return res.json({ code: 2 });
});
