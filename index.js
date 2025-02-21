const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const PORT = 3000;
const OLLAMA_URL = "http://10.126.15.125:11434/api/generate";

app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.post("/ask", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ message: "WebSocket connection established" }));

  const ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on("open", () => {
    ws.send(JSON.stringify(req.body));
  });

  ws.on("message", (data) => {
    console.log("Received:", data);
  });
});

wss.on("connection", (ws) => {
  ws.on("message", async (message) => {
    const { machine, prompt } = JSON.parse(message);

    try {
      const response = await axios.post(
        OLLAMA_URL,
        {
          model: machine,
          prompt: prompt,
          stream: true,
        },
        { responseType: "stream" }
      );

      response.data.on("data", (chunk) => {
        try {
          const jsonChunks = chunk.toString().trim().split("\n");
          jsonChunks.forEach((jsonChunk) => {
            const parsed = JSON.parse(jsonChunk);
            if (parsed.response) {
              console.log(parsed.response); // Log hasil ke console
              ws.send(parsed.response);
            }
          });
        } catch (err) {
          console.error("Error parsing stream chunk:", err);
        }
      });

      response.data.on("end", () => {
        ws.close();
      });
    } catch (error) {
      console.error("Error fetching Ollama:", error.message);
      ws.send(JSON.stringify({ error: "Failed to get response from Ollama" }));
      ws.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
