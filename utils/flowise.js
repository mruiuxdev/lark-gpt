const axios = require("axios");
const { FLOWISE_API_URL, FLOWISE_API_KEY } = process.env;

const flowiseAPI = axios.create({
  baseURL: FLOWISE_API_URL,
  headers: {
    Authorization: `Bearer ${FLOWISE_API_KEY}`,
  },
});

const sendToFlowise = async (input, sessionId) => {
  try {
    const response = await flowiseAPI.post("/chat", {
      query: input,
      sessionId: sessionId,
    });
    return response.data;
  } catch (error) {
    console.error("Flowise API Error:", error);
    throw error;
  }
};

module.exports = { sendToFlowise };
