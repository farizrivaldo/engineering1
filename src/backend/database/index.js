require("dotenv").config();
const mysql = require("mysql2");
const util = require("util");
const db = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE1,
  port: process.env.DB_PORT,
});

const db2 = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE2,
  port: process.env.DB_PORT,
});

const db3 = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE3,
  port: process.env.DB_PORT,
});

db.connect((err) => {
  if (err) {
    return console.log(`error : ${err.message}`);
  }
  console.log("connect to mysql");
});

db2.connect((err) => {
  if (err) {
    return console.log(`error : ${err.message}`);
  }
  console.log("connect to mysql2");
});

db3.connect((err) => {
  if (err) {
    return console.log(`error : ${err.message}`);
  }
  console.log("connect to mysql3");
});

const query = util.promisify(db.query).bind(db);
const query2 = util.promisify(db2.query).bind(db2);
const query3 = util.promisify(db3.query).bind(db3);

module.exports = { db3, db2, db, query };
