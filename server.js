const express = require("express");
const dotenv = require("dotenv");
const handleRequest = require("./api/index");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Define the route
app.post("/api/index", async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error("Error handling request", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Add a test route to verify the server is working
app.get("/api/test", (req, res) => {
  res.json({ message: "API is working" });
});

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
