const fetch = require("isomorphic-fetch");
const express = require("express");
const cors = require("cors");
const { body, validationResult } = require("express-validator");
const upload = require("./middleware/multer");
const { db, db2, db3, db4, post } = require("./database");
const { databaseRouter } = require("./routers");
const { exec } = require("child_process");
const fs = require("fs");
const axios = require("axios");
const http = require("http");
const WebSocket = require("ws");

const port = 8002;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const OLLAMA_URL = "http://10.126.15.141:11434/api/generate";

// Antrian untuk permintaan
let requestQueue = [];
let isProcessing = false;

// Fungsi untuk memproses antrian
const processQueue = async () => {
  if (isProcessing || requestQueue.length === 0) return;

  isProcessing = true;
  const { req, res } = requestQueue.shift();

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: req.body.machine,
      prompt: req.body.prompt,
    });

    res.json(response.data);
    console.log(response.data);
  } catch (error) {
    console.error("Error fetching Ollama:", error.message);
    res.status(500).json({ error: "Failed to get response from Ollama" });
  } finally {
    isProcessing = false;
    processQueue(); // Proses permintaan berikutnya dalam antrian
  }
};

app.post("/ask-ollama", (req, res) => {
  requestQueue.push({ req, res });
  processQueue();
});

// Logging middleware to log request body
app.use((req, res, next) => {
  console.log(`Request Body: ${JSON.stringify(req.body)}`);
  next();
});

// Error handling middleware for JSON parsing errors
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    console.error("Bad JSON:", err.message);
    return res.status(400).send({ error: "Invalid JSON payload" });
  }
  next();
});

app.post(
  "/validation",
  body("email").isEmail(),
  body("password").isLength({ min: 5 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array() });
    }
    return res.status(200).send(req.body);
  }
);

app.get("/plc", async (req, res) => {
  try {
    const response = await fetch("http://10.126.15.134/awp/data/data.js");
    const data = await response.text();
    res.send(data);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const { file } = req;
  const filepath = file ? "/" + file.filename : null;
  let data;
  try {
    data = JSON.parse(req.body.data);
  } catch (err) {
    console.error(err);
    return res.status(400).send({ error: "Invalid JSON payload" });
  }

  res.status(200).send({ filepath });

  let fetchQuery = `UPDATE parammachine_saka.users SET imagePath = ${db.escape(
    filepath
  )} WHERE id_users = ${db.escape(data.id)}`;

  db.query(fetchQuery, (err, result) => {
    if (err) {
      console.error(err);
      res.status(500).send({
        isSuccess: false,
        message: "Error updating database",
      });
    } else {
      res.status(200).send({ isSuccess: true, message: "Success update data" });
    }
  });
});

app.post("/generate", (req, res) => {
  const { model, prompt } = req.body;
  const command = `curl.exe -X POST http://10.126.15.141:11434/api/generate -H "Content-Type: application/json" -d "{\\"model\\":\\"${model}\\", \\"prompt\\":\\"${prompt}\\"}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(error);
      res.status(500).send(`Error: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(stderr);
      res.status(500).send(`Stderr: ${stderr}`);
      return;
    }
    try {
      const jsonResponse = JSON.parse(stdout);
      res.status(200).json(jsonResponse);
    } catch (parseError) {
      console.error(parseError);
      res.status(500).send(`Failed to parse response: ${parseError.message}`);
    }
  });
});

let connectionStatus = {
  db1: "Unknown",
  db2: "Unknown",
  db3: "Unknown",
  db4: "Unknown",
  postgresql: "Unknown",
};

// Function to ping connections every 5 seconds
function pingConnections() {
  setInterval(() => {
    [db, db2, db3, db4].forEach((conn, index) => {
      conn.ping((err) => {
        const status = err ? `Error : ${err.message}` : "YOMAN";
        connectionStatus[`db${index + 1}`] = status;
      });
    });
    post.query("SELECT 1", (err) => {
      const status = err ? `Error: ${err.message}` : "YOMAN";
      connectionStatus.postgresql = status;
    });
  }, 5000);
}

// Start pinging connections
pingConnections();

// API endpoint to get connection status
app.use("/api/connection", (req, res) => {
  res.json(connectionStatus);
});

app.use("/part", databaseRouter);

// WebSocket implementation
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.post("/ask", (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify({ message: "WebSocket connection established" }));

  const ws = new WebSocket(`ws://localhost:${port}`);

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
          ws.send(JSON.stringify({ error: "Error parsing stream chunk" }));
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

server.listen(port, () => {
  console.log("SERVER RUNNING IN PORT " + port);
});
