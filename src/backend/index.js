const fetch = require("isomorphic-fetch");
const { request } = require("express");
const express = require("express");
const cors = require("cors");
const port = 8002;
const app = express();
const { databaseRouter } = require("./routers");
const { body, validationResult } = require("express-validator");
const { log } = require("console");
const { db, query } = require("./database");
const upload = require("./middleware/multer");
const mqtt = require('mqtt');
const WebSocket = require('ws');

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

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
    res.status(500).send("Internal Server Error");
  }
});

app.post("/upload", upload.single("file"), async (req, res) => {
  const { file } = req;
  const filepath = file ? "/" + file.filename : null;
  let data = JSON.parse(req.body.data);

  res.status(200).send({ filepath });

  let fetchQuerry = `UPDATE parammachine_saka.users SET imagePath = ${db.escape(
    filepath
  )} WHERE id_users = ${db.escape(data.id)}`;

  db.query(fetchQuerry, (err, result) => {
    if (err) {
      // return response.status(200).send({
      //   isSucess: true,
      //   message: "File not suport,(don't use spacing in name of file) ",
      // });
    } else {
      //return response.status(200).send({ isSucess: true, message: "Succes update data" });
    }
  });
});

//========================MQTT===============================================================================
// Konfigurasi broker MQTT
const mqttBroker = 'mqtt://10.126.15.7'; // Alamat broker Anda
const mqttTopic = 'trialMQTT';         // Topik yang ingin di-subscribe

// Hubungkan ke broker MQTT
const mqttClient = mqtt.connect(mqttBroker);

mqttClient.on('connect', () => {
    console.log('Terhubung ke broker MQTT');
    // Subscribe ke topik
    mqttClient.subscribe(mqttTopic, (err) => {
        if (!err) {
            console.log(`Berhasil subscribe ke topik: ${mqttTopic}`);
        } else {
            console.error('Gagal subscribe ke topik:', err);
        }
    });
});

mqttClient.on('error', (err) => {
    console.error('Error MQTT:', err);
});

// Buat server WebSocket
const wss = new WebSocket.Server({ host: '10.126.15.141', port: 8081 });


wss.on('connection', (ws) => {
    console.log('Klien WebSocket terhubung');

    // Kirim pesan selamat datang
    ws.send('Terhubung ke WebSocket server!');

    // Kirim pesan MQTT yang diterima ke klien WebSocket
    mqttClient.on('message', (topic, message) => {
        if (topic === mqttTopic) {
            console.log(`Pesan dari MQTT: ${message.toString()}`);
            ws.send(`Pesan dari MQTT [${topic}]: ${message.toString()}`);
        }
    });

    // Tangkap pesan dari klien WebSocket
    ws.on('message', (msg) => {
        console.log(`Pesan dari klien WebSocket: ${msg}`);
    });

    // Tangkap koneksi yang ditutup
    ws.on('close', () => {
        console.log('Klien WebSocket terputus');
    });
});

console.log('Server WebSocket berjalan di ws://localhost:8080');



app.use("/part", databaseRouter);

app.listen(port, () => {
  console.log("SERVER RUNNING IN PORT" + port);
});
