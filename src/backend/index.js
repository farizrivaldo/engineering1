const fetch = require("isomorphic-fetch");
// const { request } = require("express");
const express = require("express");
const cors = require("cors");
const port = 8002;
const app = express();
const { databaseRouter } = require("./routers");
const { body, validationResult } = require("express-validator");
// const { log } = require("console");
const upload = require("./middleware/multer");
// const mqtt = require("mqtt");
// const WebSocket = require("ws");
// const EventEmitter = require("events");
const { db, db2, db3, db4, post, query } = require("./database");


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
//========================MQTT===============================================================================
// Konfigurasi broker MQT // Pastikan Anda telah menginstal package 'mqtt' dengan `npm install mqtt`
// const mqttBroker = "mqtt://10.126.15.7"; // Alamat broker Anda
// const mqttTopic1 = "kwhmeter"; // Topik yang ingin di-subscribe
// const mqttTopic2 = "dbwater"; // Topik yang ingin di-subscribe
// const mqttTopic3 = "totalgas"; // Topik yang ingin di-subscribe
// const mqttTopic4 = "masterbox"; // Topik yang ingin di-subscribe

// Hubungkan ke broker MQTT
// const mqttClient = mqtt.connect(mqttBroker);
// EventEmitter.defaultMaxListeners = 20;
// mqttClient.on("connect", () => {
//   console.log("Terhubung ke broker MQTT");
//   // Subscribe ke topik
//   mqttClient.subscribe(mqttTopic1, (err) => {
//     if (!err) {
//       console.log(`Berhasil subscribe ke topik: ${mqttTopic1}`);
//     } else {
//       console.error("Gagal subscribe ke topik:", err);
//     }
//   });

//   mqttClient.subscribe(mqttTopic2, (err) => {
//     if (!err) {
//       console.log(`Berhasil subscribe ke topik: ${mqttTopic2}`);
//     } else {
//       console.error("Gagal subscribe ke topik:", err);
//     }
//   });

//   mqttClient.subscribe(mqttTopic3, (err) => {
//     if (!err) {
//       console.log(`Berhasil subscribe ke topik: ${mqttTopic3}`);
//     } else {
//       console.error("Gagal subscribe ke topik:", err);
//     }
//   });

//   mqttClient.subscribe(mqttTopic4, (err) => {
//     if (!err) {
//       console.log(`Berhasil subscribe ke topik: ${mqttTopic4}`);
//     } else {
//       console.error("Gagal subscribe ke topik:", err);
//     }
//   });
// });

// // Tangani error jika ada
// mqttClient.on("error", (err) => {
//   console.error("Error MQTT:", err);
// });

// // Event ketika menerima pesan dari topik
// mqttClient.on("message", (topic, message) => {
//   // console.log(`Pesan diterima dari topik "${topic}": ${message.toString()}`);
//   // console.log(mqttClient.listenerCount("message"));
// });

// // Buat server WebSocket
// const wss = new WebSocket.Server({ host: "127.0.0.1", port: 8081 });

// wss.on("connection", (ws) => {
//   //console.log("Klien WebSocket terhubung");

//   // Kirim pesan selamat datang
//   ws.send("Terhubung ke WebSocket server!");

//   // // Kirim pesan MQTT yang diterima ke klien WebSocket
//   // mqttClient.on("message", (topic, message) => {
//   //   if (topic === mqttTopic1) {
//   //     console.log(`Pesan dari MQTT: ${message.toString()}`);
//   //     ws.send(`Pesan dari MQTT [${topic}]: ${message.toString()}`);
//   //   }
//   // });

//   // mqttClient.on("message", (topic, message) => {
//   //   if (topic === mqttTopic2) {
//   //     //console.log(`Pesan dari MQTT: ${message.toString()}`);
//   //     ws.send(`Pesan dari MQTT [${topic}]: ${message.toString()}`);
//   //   }
//   // });

//   // mqttClient.on("message", (topic, message) => {
//   //   if (topic === mqttTopic3) {
//   //     // console.log(`Pesan dari MQTT: ${message.toString()}`);
//   //     ws.send(`Pesan dari MQTT [${topic}]: ${message.toString()}`);
//   //   }
//   // });

//   // mqttClient.on("message", (topic, message) => {
//   //   if (topic === mqttTopic4) {
//   //     // console.log(`Pesan dari MQTT: ${message.toString()}`);
//   //     ws.send(`Pesan dari MQTT [${topic}]: ${message.toString()}`);
//   //   }
//   // });

//   const previousValues = {
//     [mqttTopic1]: null,
//     [mqttTopic2]: null,
//     [mqttTopic3]: null,
//     [mqttTopic4]: null,
//   };

//   mqttClient.on("message", (topic, message) => {
//     try {
//       // Bersihkan pesan dari karakter tak diinginkan
//       const cleanedMessage = message
//         .toString()
//         .replace(/\\x0B|\+/g, "")
//         .replace(/\s|\+/g, "")
//         .replace(/\t/g, "")
//         .replace(/\f/g, "");

//       // Parse pesan menjadi JSON
//       const parsedMessage = JSON.parse(cleanedMessage);

//       if (parsedMessage && parsedMessage.d) {
//         // Ambil nilai sebelumnya jika ada
//         const previousData = previousValues[topic] || {};

//         // Proses data di dalam properti `d`
//         for (const [key, value] of Object.entries(parsedMessage.d)) {
//           const newValue = value[0];

//           // Gunakan nilai sebelumnya jika `newValue` adalah 0
//           if (newValue === 0 && previousData[key] !== undefined) {
//             parsedMessage.d[key] = [previousData[key]];
//           } else {
//             // Simpan nilai baru ke `previousValues`
//             previousData[key] = newValue;
//           }
//         }

//         // Perbarui nilai sebelumnya untuk topik ini
//         previousValues[topic] = previousData;

//         // Kirim data ke WebSocket
//         ws.send(`Pesan dari MQTT [${topic}]: ${JSON.stringify(parsedMessage)}`);
//       }
//     } catch (error) {
//       console.error(`Error processing MQTT message for topic ${topic}:`, error);
//     }
//   });

//   //=====================================================================

//   ws.on("message", (msg) => {
//     //console.log(`Pesan dari klien WebSocket: ${msg}`);
//   });

//   ws.on("close", () => {
//     //console.log("Klien WebSocket terputus");
//   });
//   //================================================================================
//   // wss.on("connection", (ws) => {
//   //   console.log("Klien WebSocket terhubung");

//   //   ws.send("Terhubung ke WebSocket server!");

//   //   if (mqttClient.listenerCount("message") === 0) {
//   //     mqttClient.on("message", mqttMessageHandler);
//   //   }

//   //   ws.on("close", () => {
//   //     console.log("Klien WebSocket terputus");
//   //     mqttClient.removeListener("message", mqttMessageHandler);
//   //   });
//   // });
// });

// setInterval(() => {
//   const listenerCount = mqttClient.listenerCount("message");
//   // console.log(`Jumlah listener: ${listenerCount}`);

//   if (listenerCount >= 300) {
//     console.warn("Listener melebihi batas, melakukan reset...");

//     // Hapus semua listener
//     mqttClient.removeAllListeners("message");

//     // Tambahkan listener baru
//     mqttClient.on("message", handleMessage);
//     ws.on("message");

//     // console.log("Listener telah direset ke 1.");
//   }
// }, 5000); // Periksa setiap 5 detik

// console.log("Server WebSocket berjalan di ws://localhost:8080");
// Check database connection every 5 seconds

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
        // console.log(`Ping db${index + 1}: ${status}`);
        connectionStatus[`db${index + 1}`] = status;
      });
    });
    post.query("SELECT 1", (err) => {
      const status = err ? `Error: ${err.message}` : "YOMAN";
      // console.log(`Ping postgresql: ${status}`);
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

app.listen(port, () => {
  console.log("SERVER RUNNING IN PORT" + port);
});
