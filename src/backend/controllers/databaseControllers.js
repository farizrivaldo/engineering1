const {
  post,
  db4,
  db3,
  db2,
  db,
  query,
  query2,
  query3,
  query4,
  query5,
} = require("../database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("../helpers/nodemailers");
const { request, response } = require("express");
const { log } = require("util");
const { data } = require("jquery");
const { timestamp } = require("node-opcua");
const mysql = require("mysql2/promise");
const cors = require("cors");
const express = require("express");


const app = express(); // Tambahkan ini jika belum ada

const fs = require('fs');
const csv = require('csv-parser');

//db  = 55, paramachine_saka
//db2 = 55, ems_saka
//db3 =  138, parmammachine
//db4 = 138,ems_saka

const corsOptions = {
  origin: "http://http://10.126.15.7:3000/", // Ganti dengan domain Grafana Anda
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

const CSV_FILE_PATH = 'C:\\Users\\Acer\\Documents\\GitHub\\engineering1\\src\\backend\\excel\\PMP MAINTENANCE 2025 - NOV 25.csv';
const DB_TABLE_NAME = 'extracted_maintenance_data'; 
const HEADER_ROW_INDEX = 5;
const FINAL_COLUMNS = ['machine_name', 'asset_number', 'wo_no'];

const processArchiveForShift = async (dateStr, shiftNum) => {
    // A. Define Times (Same as before)
    const getShiftRange = (dStr, sNum) => {
        const nextDay = new Date(dStr); 
        nextDay.setDate(nextDay.getDate() + 1);
        const nextStr = nextDay.toISOString().split('T')[0];
        if (sNum === 1) return { start: `${dStr} 06:30:00`, end: `${dStr} 15:00:00` };
        if (sNum === 2) return { start: `${dStr} 15:00:00`, end: `${dStr} 22:45:00` };
        if (sNum === 3) return { start: `${dStr} 22:45:00`, end: `${nextStr} 06:30:00` };
    };

    const currentShiftRange = getShiftRange(dateStr, shiftNum);
    const allShifts = [getShiftRange(dateStr, 1), getShiftRange(dateStr, 2), getShiftRange(dateStr, 3)];

    // B. Query Raw DB (fette_machine_dummy)
    const queries = [currentShiftRange, ...allShifts].map(range => {
        const sql = `SELECT MAX(runtime) as max_run, MIN(runtime) as min_run, MAX(stoptime) as max_stop, MIN(stoptime) as min_stop, MAX(total_product) as max_prod, MIN(total_product) as min_prod, MAX(planned_stoptime) as max_planned, MIN(planned_stoptime) as min_planned, MAX(unplanned_stoptime) as max_unplanned, MIN(unplanned_stoptime) as min_unplanned, MAX(reject) as max_reject, MIN(reject) as min_reject FROM fette_machine_dummy WHERE record_time BETWEEN ? AND ?`;
        return new Promise((resolve, reject) => {
            db4.query(sql, [range.start, range.end], (err, res) => err ? reject(err) : resolve({ ...res[0], duration: (new Date(range.end) - new Date(range.start)) / 60000 }));
        });
    });

    const [shiftResult, s1Res, s2Res, s3Res] = await Promise.all(queries);

    // C. Calculate Stats
    const calculateStats = (resultsArray) => {
        let tRun = 0, tStop = 0, tUnplan = 0, tPlan = 0, tTime = 0, tOut = 0, tRej = 0;
        const list = Array.isArray(resultsArray) ? resultsArray : [resultsArray];

        list.forEach(r => {
            tRun += (r.max_run || 0) - (r.min_run || 0);
            tStop += (r.max_stop || 0) - (r.min_stop || 0);
            tUnplan += (r.max_unplanned || 0) > 0 ? (r.max_unplanned - r.min_unplanned) : 0;
            tPlan += (r.max_planned || 0) - (r.min_planned || 0);
            tOut += (r.max_prod || 0) - (r.min_prod || 0);
            tRej += (r.max_reject || 0) - (r.min_reject || 0);
            tTime += r.duration;
        });

        const calculatedStop = tStop > 0 ? tStop : (tUnplan + tPlan);
        const avail = tTime - tPlan > 0 ? ((tRun - tUnplan) / (tTime - tPlan)) * 100 : 0;
        const perf = (tRun * 5833) > 0 ? (tOut / (tRun * 5833)) * 100 : 0;
        const qual = tOut > 0 ? ((tOut - tRej) / tOut) * 100 : 0;
        const oee = (avail * perf * qual) / 10000;

        // Return stats (we don't need raw values for the INSERT anymore)
        return { avail, perf, qual, oee };
    };

    const shiftStats = calculateStats(shiftResult);
    const dailyStats = calculateStats([s1Res, s2Res, s3Res]);

    // D. Integers for HMI
    const toInt = (val) => Math.round(val * 100);
    const toRem = (val) => 10000 - Math.round(val * 100);

    const hmi = {
        avail: toInt(shiftStats.avail), avail2: toRem(shiftStats.avail),
        perf: toInt(shiftStats.perf), perf2: toRem(shiftStats.perf),
        qual: toInt(shiftStats.qual), qual2: toRem(shiftStats.qual),
        oee: toInt(shiftStats.oee), oee2: toRem(shiftStats.oee),
    };

    // E. Insert (UPDATED TABLE NAME & COLUMNS)
    // Note: We use 'oee_master_logs' and removed the raw shift_run_time columns
    const sqlInsert = `
        INSERT INTO oee_master_logs (
            production_date, shift_name,
            availability_value_shift, availability_value_daily,
            performance_value_shift, performance_value_daily,
            quality_value_shift, quality_value_daily,
            oee_value_shift, oee_value_daily,
            hmi_avail_value, hmi_avail_value2, hmi_perf_value, hmi_perf_value2,
            hmi_qual_value, hmi_qual_value2, hmi_oee_shift_value, hmi_oee_shift_value2
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
            availability_value_shift = VALUES(availability_value_shift),
            availability_value_daily = VALUES(availability_value_daily),
            performance_value_shift = VALUES(performance_value_shift),
            performance_value_daily = VALUES(performance_value_daily),
            quality_value_shift = VALUES(quality_value_shift),
            quality_value_daily = VALUES(quality_value_daily),
            oee_value_shift = VALUES(oee_value_shift),
            oee_value_daily = VALUES(oee_value_daily),
            hmi_avail_value = VALUES(hmi_avail_value),
            hmi_perf_value = VALUES(hmi_perf_value),
            hmi_qual_value = VALUES(hmi_qual_value),
            hmi_oee_shift_value = VALUES(hmi_oee_shift_value)
    `;

    const values = [
        currentShiftRange.start, `Shift ${shiftNum}`,
        shiftStats.avail, dailyStats.avail,
        shiftStats.perf, dailyStats.perf,
        shiftStats.qual, dailyStats.qual,
        shiftStats.oee, dailyStats.oee,
        hmi.avail, hmi.avail2,
        hmi.perf, hmi.perf2,
        hmi.qual, hmi.qual2,
        hmi.oee, hmi.oee2
        // REMOVED RAW VALUES HERE
    ];

    await new Promise((resolve, reject) => db4.query(sqlInsert, values, (err) => err ? reject(err) : resolve()));
    return { shiftStats, hmi };
};

module.exports = {
  fetchOee: async (request, response) => {
    let fetchQuerry =
      " SELECT `data_index` as 'id', `time@timestamp` as 'time',COALESCE(`data_format_0`, 0) AS 'avability',  COALESCE(`data_format_1`, 0) AS 'performance',  COALESCE(`data_format_2`, 0) AS 'quality',  COALESCE(`data_format_3`, 0) AS 'oee',  COALESCE(`data_format_4`, 0) AS 'output',  COALESCE(`data_format_5`, 0) AS 'runTime',  COALESCE(`data_format_6`, 0) AS 'stopTime',COALESCE(`data_format_7`, 0) AS 'idleTime' FROM " +
      " " +
      "`" +
      request.query.machine +
      "`" +
      "where `time@timestamp` between" +
      " " +
      request.query.start +
      " " +
      "and" +
      " " +
      request.query.finish;

    db3.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchVariableOee: async (request, response) => {
    let fetchQuerry =
      "SELECT AVG(`data_format_0`) as Ava, AVG(`data_format_1`) as Per,  AVG(`data_format_2`) as Qua, AVG(`data_format_3`) AS  oee   FROM " +
      " " +
      "`" +
      request.query.machine +
      "`" +
      " " +
      " where `time@timestamp` between" +
      " " +
      request.query.start +
      " " +
      "and" +
      " " +
      request.query.finish;

    db3.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchDataHardness: async (request, response) => {
    const { nobatch } = request.body;
    let fetchQuerry = `SELECT  id as x , hardness AS y FROM instrument WHERE nobatch= ${db2.escape(
      nobatch
    )} ORDER BY id DESC `;
    db2.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataTickness: async (request, response) => {
    const { nobatch } = request.body;
    let fetchQuerry = `SELECT  id as x , thickness AS y FROM instrument WHERE nobatch= ${db2.escape(
      nobatch
    )} ORDER BY id DESC `;
    db2.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataDiameter: async (request, response) => {
    const { nobatch } = request.body;
    let fetchQuerry = `SELECT  id as x , diameter AS y FROM instrument WHERE nobatch= ${db2.escape(
      nobatch
    )} `;
    db2.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchDataInstrument: async (request, response) => {
    let fetchQuerry = `select * from instrument ORDER BY id DESC`;
    db2.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchDataLine1: async (request, response) => {
    const date = request.query.date;

    let fetchquerry = `SELECT Mesin , SUM(total)AS Line1 FROM part WHERE MONTH(tanggal) = ${date} AND Line='Line1' GROUP BY Mesin`;
    db.query(fetchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataLine2: async (request, response) => {
    const date = request.query.date;

    let fetchquerry = `SELECT Mesin , SUM(total)AS Line2 FROM part WHERE MONTH(tanggal) = ${date} AND Line='Line2' GROUP BY Mesin`;
    db.query(fetchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataLine3: async (request, response) => {
    const date = request.query.date;
    let fetchquerry = `SELECT Mesin , SUM(total)AS Line3 FROM part WHERE MONTH(tanggal) = ${date} AND Line='Line3' GROUP BY Mesin`;
    db.query(fetchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataLine4: async (request, response) => {
    let fetchquerry =
      "SELECT Mesin , SUM(total)AS Line4 FROM part WHERE MONTH(tanggal) = 4 AND WHERE Line='Line4' GROUP BY Mesin";
    db.query(fetchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  fetchDataPareto: async (request, response) => {
    const date = request.query.date;

    let fatchquerry = `SELECT Line, SUM(total) AS y FROM parammachine_saka.part WHERE MONTH(tanggal) = ${date} GROUP BY Line ORDER BY Line ASC;`;
    db.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getData: async (request, response) => {
    const date = request.query.date;

    var fatchquerry = `SELECT * FROM parammachine_saka.part WHERE MONTH(tanggal) = ${date};`;

    db.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },
  
  fetchEdit: async (request, response) => {
    var fatchquerry = `SELECT * FROM parammachine_saka.part`;

    db.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==========================================DATA INPUT =================================================

  addData: async (request, response) => {
    const {
      Mesin,
      Line,
      Pekerjaan,
      Detail,
      Tanggal,
      Quantity,
      Unit,
      Pic,
      Tawal,
      Tahir,
      Total,
    } = request.body;
    let postQuery = `INSERT INTO part VALUES (null, ${db.escape(
      Mesin
    )}, ${db.escape(Line)}, ${db.escape(Pekerjaan)}, ${db.escape(
      Detail
    )}, ${db.escape(Tanggal)}, ${db.escape(Quantity)}, ${db.escape(
      Unit
    )}, ${db.escape(Pic)}, ${db.escape(Tawal)}, ${db.escape(
      Tahir
    )}, ${db.escape(Total)})`;
    db.query(postQuery, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        let fatchquerry = "SELECT * FROM part";
        db.query(fatchquerry, (err, result) => {
          return response.status(200).send(result);
        });
      }
    });
  },

  editData: async (request, response) => {
    let dataUpdate = [];
    let idParams = request.params.id;
    for (let prop in request.body) {
      dataUpdate.push(`${prop} = ${db.escape(request.body[prop])}`);
    }
    let updateQuery = `UPDATE part set ${dataUpdate} where id = ${db.escape(
      idParams
    )}`;

    db.query(updateQuery, (err, result) => {
      if (err) response.status(500).send(err);
      response.status(200).send(result);
    });
  },

  deletData: async (request, response) => {
    let idParams = request.params.id;
    let deleteQuery = `DELETE FROM part WHERE id = ${db.escape(idParams)}`;
    db.query(deleteQuery, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        return response
          .status(200)
          .send({ isSucess: true, message: "Succes delete data" });
      }
    });
  },

  lineData: async (request, response) => {
    let queryData = "SELECT * FROM parammachine_saka.line_db";

    db2.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  procesData: async (request, response) => {
    let data = request.query.line_name;

    let queryData = `SELECT * FROM parammachine_saka.proces_db where line_name = ${db.escape(
      data
    )} `;
    db2.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  machineData: async (request, response) => {
    let data = request.query.line_name;
    let data2 = request.query.proces_name;

    let queryData = `SELECT * FROM parammachine_saka.machine_db where line_name = ${db.escape(
      data
    )} AND proces_name = ${db.escape(data2)}`;
    db2.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  locationData: async (request, response) => {
    let data = request.query.line_name;
    let data2 = request.query.proces_name;
    let data3 = request.query.machine_name;
    let queryData = `SELECT * FROM parammachine_saka.location_db where line_name = ${db.escape(
      data
    )} AND proces_name = ${db.escape(data2)} AND machine_name = ${db.escape(
      data3
    )} `;
    db2.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //=====================================(Login & Register)===============================================================================

  register: async (req, res) => {
    const { username, email, name, password } = req.body;

    let getEmailQuery = `SELECT * FROM users WHERE email=${db.escape(email)}`;
    let isEmailExist = await query(getEmailQuery);
    if (isEmailExist.length > 0) {
      return res.status(400).send({ message: "Email has been used" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashPassword = await bcrypt.hash(password, salt);
    const defaultImage =
      "https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png";
    let addUserQuery = `INSERT INTO users VALUES (null, ${db.escape(
      username
    )}, ${db.escape(email)}, ${db.escape(hashPassword)}, ${db.escape(
      name
    )}, false,1,null)`;
    let addUserResult = await query(addUserQuery);

    let mail = {
      from: `Admin <khaerul.fariz98@gmail.com>`,
      to: `${email}`,
      subject: `Acount Verification`,
      html: `<a href="http://10.126.15.137/" > Verification Click here</a>`,
    };

    let response = await nodemailer.sendMail(mail);

    return res
      .status(200)
      .send({ data: addUserResult, message: "Register success" });
  },
  login: async (req, res) => {
    try {
      const { email, password } = req.body;
      //console.log(req.body);
      // if (db.connection.state === "disconnected") {
      //   await db.connection.connect();
      // }
      // console.log(db.connection.state);

      const isEmailExist = await query(
        `SELECT * FROM users WHERE email = ${db.escape(email)}`
      );

      if (isEmailExist.length == 0) {
        return res.status(400).send({ message: "email & password infailid1" });
      }

      const isValid = await bcrypt.compare(password, isEmailExist[0].password);

      if (!isValid) {
        return res.status(400).send({ message: "email & password infailid2" });
      }

      let payload = {
        name: isEmailExist[0].name,
        id: isEmailExist[0].id_users,
        isAdmin: isEmailExist[0].isAdmin,
        level: isEmailExist[0].level,
        imagePath: isEmailExist[0].imagePath,
      };
      const token = jwt.sign(payload, "khaerul", { expiresIn: "1h" });
      // const token = jwt.sign(payload, "khaerul");
      //const token = jwt.sign(payload, "khaerul", { expiresIn: 600 }); // 5 menit

      console.log(token);
      delete isEmailExist[0].password;
      return res.status(200).send({
        token,
        message: "email & password sucess",
        data: isEmailExist[0],
      });
    } catch (error) {
      res.status(error.status || 500).send(error);
      console.log(error);
    }
  },
  
  loginData: async (req, res) => {
    try {
      // console.log('\n========== LOGIN TRACKING ==========');
      // console.log('📥 Received request at loginData endpoint');
      // console.log('📥 Received token in header:', req.headers.authorization ? 'Yes' : 'No');
      // console.log('🔓 Decoded user from token:', req.user);
      
      const userId = req.user.id; // Extract user_id from token
      const userName = req.user.name; // Extract user name from token
      const loginTime = new Date();
      
      // console.log('👤 User ID:', userId);
      // console.log('📛 User Name:', userName);
      // console.log('🕐 Login Time:', loginTime.toLocaleString());
      // console.log('====================================\n');
      
      // Log the login activity to database or perform any tracking needed
      // You can create a login_logs table if needed
      
      return res.status(200).send({
        message: "Login activity tracked successfully",
        data: {
          userId: userId,
          userName: userName,
          loginTime: loginTime
        }
      });
    } catch (error) {
      console.error('❌ Error tracking login:', error);
      res.status(error.statusCode || 500).send({message: 'Error tracking login', error: error.message});
    }
  },

  logoutData: async (req, res) => {
    try {
      // console.log('\n========== LOGOUT TRACKING ==========');
      // console.log('📥 Received token in header:', req.headers.authorization ? 'Yes' : 'No');
      // console.log('🔓 Decoded user from token:', req.user);
      
      const userId = req.user.id; // Extract user_id from token
      const userName = req.user.name; // Extract user name from token
      const logoutTime = new Date();
      
      // console.log('👤 User ID:', userId);
      // console.log('📛 User Name:', userName);
      // console.log('🕐 Logout Time:', logoutTime.toLocaleString());
      // console.log('=====================================\n');
      
      // Log the logout activity to database or perform any tracking needed
      
      return res.status(200).send({
        message: "Logout activity tracked successfully",
        data: {
          userId: userId,
          userName: userName,
          logoutTime: logoutTime
        }
      });
    } catch (error) {
      console.error("❌ Error tracking logout:", error);
      res.status(error.statusCode || 500).send(error);
    }
  },

  fetchAlluser: async (req, res) => {
    try {
      const users = await query(`SELECT * FROM users`);
      return res.status(200).send(users);
    } catch (error) {
      res.status(error.statusCode || 500).send(error);
    }
  },

  checkLogin: async (req, res) => {
    try {
      const users = await query(
        `SELECT * FROM users WHERE id_users = ${db.escape(req.user.id)}`
      );
      return res.status(200).send({
        data: {
          name: users[0].name,
          id: users[0].id_users,
          isAdmin: users[0].isAdmin,
          level: users[0].level,
          imagePath: users[0].imagePath,
        },
      });
    } catch (error) {
      res.status(error.statusCode || 500).send(error);
    }
  },

  updateUsers: async (request, response) => {
    let idParams = request.params.id;
    let levelParams = request.body.level;

    let updateQuery = `UPDATE parammachine_saka.users set level = ${db.escape(
      levelParams
    )} where id_users  = ${db.escape(idParams)}`;

    db.query(updateQuery, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        return response
          .status(200)
          .send({ isSucess: true, message: "Succes update data" });
      }
    });
  },

  editUsers: (request, response) => {
    let idParams = request.params.id;
    let updateQuery = `UPDATE parammachine_saka.users set level = NULL where id_users  = ${db.escape(
      idParams
    )}`;
    db.query(updateQuery, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        return response
          .status(200)
          .send({ isSucess: true, message: "Succes update data" });
      }
    });
  },

  deleteUseers: async (request, response) => {
    let idParams = request.params.id;
    let query = `DELETE FROM parammachine_saka.users WHERE id_users = ${db.escape(
      idParams
    )}`;

    db.query(query, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        return response
          .status(200)
          .send({ isSucess: true, message: "Succes delete data" });
      }
    });
  },

  changePassword: async (request, response) => {
    try {
      const { email, newPassword } = request.body;
      console.log(email, newPassword);

      const isEmailExist = await query(
        `SELECT * FROM users WHERE email = ${db.escape(email)}`
      );
      if (isEmailExist.length == 0) {
        return res.status(400).send({ message: "email & password infailid1" });
      }
      const salt = await bcrypt.genSalt(10);
      const hashPassword = await bcrypt.hash(newPassword, salt);
      await query(
        `UPDATE parammachine_saka.users SET password = ${db.escape(
          hashPassword
        )} WHERE email = ${db.escape(email)}`
      );
      return response
        .status(200)
        .send({ message: "password changed successfully" });
    } catch (error) {
      response.status(error.status || 500).send(error);
      console.log(error);
    }
  },

  //=========================UTILITY=============================================

  fetchEMSn14: async (request, response) => {
    let fetchQuerry =
      "SELECT * FROM parammachine_saka.`cMT-PowerMeterMezzanine_R._N14_& _N14_data`;";
    db2.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //========================OPE=================================================

  fetchOPE: async (request, response) => {
    const date = request.query.date;
    let query =
      "SELECT AVG(data_format_0) AS Ava, AVG(data_format_1) AS Per, AVG(data_format_2) AS Qua, AVG(data_format_3) AS OEE FROM ( SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm1_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm2_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm3_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm4_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm5_data`    ) AS subquery WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      date;
    db2.query(query, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchAvaLine: async (request, response) => {
    const date = request.query.date;
    let query =
      "SELECT AVG(data_format_0) AS Ava1 FROM ( SELECT *  FROM parammachine_saka.`mezanine.tengah_Cm1_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm2_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm3_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm4_data`      UNION ALL      SELECT *      FROM parammachine_saka.`mezanine.tengah_Cm5_data`    ) AS subquery WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      date;
    db2.query(query, (err, result) => {
      return response.status(200).send(result);
    });
  },

  fetchAvaMachine: async (request, response) => {
    const date = request.query.date;
    let query =
      "SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability CM1' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_Cm1_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      `${db.escape(date)}` +
      " UNION ALL SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability CM2' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_Cm2_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      `${db.escape(date)}` +
      " UNION ALL SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability CM3' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_Cm3_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      `${db.escape(date)}` +
      " UNION ALL SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability CM4' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_Cm4_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      `${db.escape(date)}` +
      " UNION ALL SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability CM5' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_Cm5_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      `${db.escape(date)}` +
      // " UNION ALL SELECT CAST(FORMAT(AVG(data_format_0),2) AS CHAR) AS indexLabel, 'Avability HM1' AS label, AVG(data_format_0) AS y FROM parammachine_saka.`mezanine.tengah_HM1_data` WHERE MONTH(FROM_UNIXTIME(`time@timestamp`)) = " +
      // `${db.escape(date)}` +
      " ORDER BY y DESC;";

    db2.query(query, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //=================Maintenance Report ==============================================================
  reportMTC: async (request, response) => {
    const {
      line,
      proces,
      machine,
      location,
      pic,
      tanggal,
      start,
      finish,
      total,
      sparepart,
      quantity,
      unit,
      PMjob,
      PMactual,
      safety,
      quality,
      status,
      detail,
      breakdown,
    } = request.body;

    let queryData = `INSERT INTO parammachine_saka.mtc_report VALUES (null, 
      ${db.escape(line)}, ${db.escape(proces)}, ${db.escape(
      machine
    )}, ${db.escape(location)},
      ${db.escape(pic)}, ${db.escape(tanggal)}, ${db.escape(
      start
    )}, ${db.escape(finish)}, 
      ${db.escape(total)}, ${db.escape(sparepart)}, ${db.escape(
      quantity
    )}, ${db.escape(unit)},
      ${db.escape(PMjob)}, ${db.escape(PMactual)}, ${db.escape(
      safety
    )}, ${db.escape(quality)},
      ${db.escape(status)}, ${db.escape(detail)} ,${db.escape(breakdown)}
      )`;

    console.log(queryData);

    db.query(queryData, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        let fatchquerry = "SELECT * FROM parammachine_saka.mtc_report";
        db.query(fatchquerry, (err, result) => {
          return response
            .status(200)
            .send({ message: "data successfully added" });
        });
      }
    });
  },

  reportPRD: async (request, response) => {
    const {
      datetime,
      outputCM1,
      outputCM2,
      outputCM3,
      outputCM4,
      outputCM5,
      afkirCM1,
      afkirCM2,
      afkirCM3,
      afkirCM4,
      afkirCM5,
      percentageCm1,
      percentageCm2,
      percentageCm3,
      percentageCm4,
      percentageCm5,
      totalBox,
      totalMB,
      information,
    } = request.body;

    let queryData = `INSERT INTO parammachine_saka.prod_report VALUES (null,${db.escape(
      datetime
    )},${db.escape(outputCM1)}, ${db.escape(outputCM2)},${db.escape(
      outputCM3
    )},${db.escape(outputCM4)}, ${db.escape(outputCM5)},${db.escape(
      afkirCM1
    )}, ${db.escape(afkirCM2)}, ${db.escape(afkirCM3)},${db.escape(
      afkirCM4
    )}, ${db.escape(afkirCM5)}, ${db.escape(percentageCm1)},${db.escape(
      percentageCm2
    )},${db.escape(percentageCm3)},${db.escape(percentageCm4)},${db.escape(
      percentageCm5
    )}, ${db.escape(totalBox)},${db.escape(totalMB)},${db.escape(
      information
    )})`;

    db.query(queryData, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        let fatchquerry = "SELECT * FROM parammachine_saka.prod_report";
        db.query(fatchquerry, (err, result) => {
          return response
            .status(200)
            .send({ message: "data successfully added" });
        });
      }
    });
  },

  lastUpdatePRD: async (request, response) => {
    let queryData =
      "SELECT datetime FROM parammachine_saka.prod_report ORDER BY id DESC LIMIT 1;";
    db.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  lastUpdateMTC: async (request, response) => {
    let queryData =
      "SELECT tanggal FROM parammachine_saka.mtc_report ORDER BY tanggal DESC LIMIT 1;";
    db.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //-------------------------DATA REPORT-------------MTC-------------

  dataReportMTC: async (request, response) => {
    const date = request.query.date;

    let queryData = `SELECT * FROM parammachine_saka.mtc_report WHERE MONTH(tanggal) = ${db.escape(
      date
    )};`;
    db.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //=========================POWER MANAGEMENT============================================================

  getPowerData: async (request, response) => {
    const { area, start, finish } = request.query;

    const cleanString = area.replace(/(cMT-Gedung-UTY_|_data)/g, "");

    let queryData =
      "SELECT label,  x,  y  FROM ( SELECT (@counter := @counter + 1) AS x, label, y FROM ( SELECT p1.date AS label, p1.id AS x, p2.`" +
      cleanString +
      "` - p1.`" +
      cleanString +
      "` AS y  FROM  parammachine_saka.power_data p1 JOIN  parammachine_saka.power_data p2 ON p2.date = ( SELECT MIN(date)   FROM parammachine_saka.power_data WHERE date > p1.date  ) UNION ALL  SELECT DATE_FORMAT(FROM_UNIXTIME(p1.`time@timestamp`), '%Y-%m-%d') AS label, p1.data_index AS x, p2.`data_format_0` - p1.`data_format_0` AS y  FROM   parammachine_saka.`" +
      area +
      "` p1 JOIN ems_saka.`" +
      area +
      "` p2 ON DATE_FORMAT(FROM_UNIXTIME(p2.`time@timestamp`), '%Y-%m-%d') = ( SELECT MIN(DATE_FORMAT(FROM_UNIXTIME(`time@timestamp`), '%Y-%m-%d'))  FROM ems_saka.`" +
      area +
      "` WHERE DATE_FORMAT(FROM_UNIXTIME(`time@timestamp`), '%Y-%m-%d') > DATE_FORMAT(FROM_UNIXTIME(p1.`time@timestamp`), '%Y-%m-%d')              )      ) AS subquery      CROSS JOIN (SELECT @counter := 0) AS counter_init  ) AS result  HAVING      label >= '" +
      start +
      "'      AND label <= '" +
      finish +
      "'";
    console.log(queryData);

    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getPowerMonthly: async (request, response) => {
    const { area, start, finish } = request.query;
    const cleanString = area.replace(/(cMT-Gedung-UTY_|_data)/g, "");

    let queryData =
      " SELECT      DATE_FORMAT(label, '%b') AS label, MONTH(label) AS x,     SUM(y) AS y  FROM (      SELECT          p1.date AS label,          p1.id AS x,          p2.`" +
      cleanString +
      "` - p1.`" +
      cleanString +
      "` AS y      FROM          parammachine_saka.power_data p1      JOIN          parammachine_saka.power_data p2 ON p2.date = (              SELECT MIN(date)              FROM parammachine_saka.power_data              WHERE date > p1.date          )      UNION ALL      SELECT          DATE_FORMAT(FROM_UNIXTIME(p1.`time@timestamp`), '%Y-%m-%d') AS label,          p1.data_index AS x,          p2.`data_format_0` - p1.`data_format_0` AS y      FROM          parammachine_saka.`" +
      area +
      "` p1      JOIN          parammachine_saka.`" +
      area +
      "` p2          ON DATE_FORMAT(FROM_UNIXTIME(p2.`time@timestamp`), '%Y-%m-%d') = (              SELECT MIN(DATE_FORMAT(FROM_UNIXTIME(`time@timestamp`), '%Y-%m-%d'))              FROM parammachine_saka.`" +
      area +
      "`              WHERE DATE_FORMAT(FROM_UNIXTIME(`time@timestamp`), '%Y-%m-%d') > DATE_FORMAT(FROM_UNIXTIME(p1.`time@timestamp`), '%Y-%m-%d')          )  ) AS subquery  WHERE      MONTH(label) >= " +
      start +
      "      AND MONTH(label) <= " +
      finish +
      "  GROUP BY      MONTH(label)  ORDER BY      MONTH(label);  ";
    console.log(queryData);
    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getPowerSec: async (request, response) => {
    const { area, start, finish } = request.query;

    let queryData =
      "SELECT (`data_index`) AS id, FROM_UNIXTIME(`time@timestamp`) AS datetime, (`data_format_6`) as freq, (`data_format_0`) as PtoP,  (`data_format_3`) as PtoN,(`data_format_7`) as Crnt FROM ems_saka.`" +
      area +
      "`where `time@timestamp` between " +
      start +
      " AND " +
      finish +
      ";";

    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getAvgPower: async (request, response) => {
    const { area, start, finish } = request.query;

    let queryData =
      "SELECT avg(`data_format_0`) AS RR, avg(`data_format_1`) as SS, avg(`data_format_2`) as TT, avg(`data_format_3`) as RN, avg(`data_format_4`) as SN, avg(`data_format_5`) as TN FROM ems_saka.`" +
      area +
      "` where `time@timestamp` between " +
      start +
      " AND " +
      finish +
      " ;";

    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getRangeSet: async (request, response) => {
    let queryData = "SELECT * FROM power_setpoint";
    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },
  //===============================CHILLER COMPRESOR==================================================================

  getChillerData: async (request, response) => {
    const { chiller, kompresor, start, finish } = request.query;

    let queryData = `
    SELECT 
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
     s.data_format_0 AS 'Status Chiller',
    COALESCE(a.data_format_0, 'No Alarm') AS 'Alarm Chiller',
    COALESCE(p.data_format_0, 'No Setpoint') AS 'Active Setpoint',
    e.data_format_0 AS 'EvapLWT',
    ewt.data_format_0 AS 'EvapEWT',
    c.data_format_0 AS 'Unit Capacity',
    d.data_format_0 AS 'Status Kompresor',
    f.data_format_0 AS 'Unit Capacity',
    g.data_format_0 AS 'Evap Presure',
    h.data_format_0 AS "Cond Presure",
    i.data_format_0 AS "Evap sat Temperature",
    j.data_format_0 AS "Cond sat Temperature",
    k.data_format_0 AS "Suction Temperature",
    l.data_format_0 AS "Discharge Temperature",
    m.data_format_0 AS "Evap Approach",
    n.data_format_0 AS "Cond Approach",
    o.data_format_0 AS "Oil Presure",
    q.data_format_0 AS "EXV Position",
    r.data_format_0 AS "Run Hour Kompressor",
    t.data_format_0 AS "Ampere Kompressor",
    u.data_format_0 AS "No of Start"
    FROM 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-Status${chiller}_data\` AS s
  LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-Alarm${chiller}_data\` AS a
  ON 
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i')
LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-ActiSetpoi${chiller}_data\` AS p
  ON 
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EvapLWT${chiller}_data\` AS e
  ON 
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(e.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EvapEWT${chiller}_data\` AS ewt
  ON 
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(ewt.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-UnitCap${chiller}_data\` AS c
  ON   
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-Status${kompresor}${chiller}_data\` AS d
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN 
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-Capacity${kompresor}${chiller}_data\` AS f
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(f.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EvapPress${kompresor}${chiller}_data\` AS g
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(g.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-CondPress${kompresor}${chiller}_data\` AS h
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EvapSatTe${kompresor}${chiller}_data\` AS i
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(i.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-ConSatTem${kompresor}${chiller}_data\` AS j
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(j.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-SuctiTemp${kompresor}${chiller}_data\`AS k
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(k.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-DischTemp${kompresor}${chiller}_data\`AS l
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EvapAppro${kompresor}${chiller}_data\`AS m
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(m.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-CondAppro${kompresor}${chiller}_data\`AS n
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(n.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-OilPresDf${kompresor}${chiller}_data\`AS o
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(o.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-EXVPositi${kompresor}${chiller}_data\`AS q
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(q.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-RunHour${kompresor}${chiller}_data\`AS r
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(r.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-Ampere${kompresor}${chiller}_data\`AS t
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d %H:%i')
  LEFT JOIN
    parammachine_saka.\`CMT-DB-Chiller-UTY_R-No.Start${kompresor}${chiller}_data\`AS u
  ON
    DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(u.\`time@timestamp\`), '%Y-%m-%d %H:%i')
     WHERE 
    DATE(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR) BETWEEN '${start}' AND '${finish}'
    group by s.data_index
    order by DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i');
`;
    console.log(queryData);
    db.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getGraphChiller: async (request) => {
    const { area, chiller, kompresor, start, finish } = request.query;

    // parammachine_saka.\`CMT-DB-Chiller-UTY_${area}_${kompresor}_${chiller}_data\`
    const queryData = `
    SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS label,
        data_index AS x,
        data_format_0 AS yr
    FROM
        parammachine_saka.\`CMT-DB-Chiller-UTY_${area}_${kompresor}_${chiller}_data\`
    WHERE
        FROM_UNIXTIME(\`time@timestamp\`) >= '${start}'
        AND FROM_UNIXTIME(\`time@timestamp\`) <= '${finish}'
    ORDER BY
        \`time@timestamp\`;
  `;
    console.log(queryData);

    db.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //=====================EMS Backend====================================

  getTableEMS: async (request, response) => {
    const queryData = `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE (TABLE_NAME LIKE '%cMT-DB-EMS-UTY2%' OR TABLE_NAME LIKE '_data') AND TABLE_NAME NOT LIKE '%_data_format' AND TABLE_NAME NOT LIKE '%_data_section';`;

    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getTempChart: async (request, response) => {
    const { area, start, finish, format } = request.query;
    const queryData = `
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS label,
        data_index AS x,
        data_format_${format} AS y
      FROM \`${area}\`
      WHERE
      DATE(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 1 DAY) BETWEEN '${start}' AND '${finish}'
  ORDER BY
      \`time@timestamp\`;
    `;

    db4.query(queryData, (err, result) => {
      if (err) {
        console.error("Error executing query:", err);
        return response.status(500).send("Internal Server Error");
      }

      // Mengonversi data y ke tipe data angka pecahan (float)
      const parsedResult = result.map((entry) => ({
        ...entry,
        y: parseFloat(entry.y) / 10,
      }));

      return response.status(200).send(parsedResult);
    });
  },

  getAllDataEMS: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryData = `SELECT
    data_index AS id,
    DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 1 DAY, '%Y-%m-%d %H:%i:%s') AS date,
    ROUND(data_format_0/10, 2) AS temp,
    ROUND(data_format_1/10, 2) AS RH,
    ROUND(data_format_2/10, 2) AS DP
    FROM \`${area}\`
    WHERE
      DATE(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 1 DAY) BETWEEN '${start}' AND '${finish}'
    ORDER BY
      \`time@timestamp\``;

    db4.query(queryData, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Water Management Backend
  waterSystem: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`), '%Y-%m-%d') AS label,
      data_index AS x,
      round(data_format_0,2) AS y
      FROM \`${area}\`
      WHERE
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
      ORDER BY
      \`time@timestamp\``;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  waterSankey: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
    a AS "Pdam",
    b AS "Domestik",
    c AS "Softwater",
    d AS "Boiler",
    e AS "InletPretreatment",
    f AS "OutletPretreatment",
    g AS "RejectOsmotron",
    h AS "Chiller",
    i AS "Taman",
    j AS "WWTPBiologi",
    k AS "WWTPKimia",
    l AS "WWTPOutlet",
    m AS "Cip",
    n AS "Hotwater",
    o AS "Lab",
    p AS "AtasLabQC",
    q AS "AtasToiletLt2",
    r AS "Workshop",
    s AS "AirMancur"
    FROM 
    (SELECT SUM(data_format_0) as a 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_PDAM_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' ) as sum1,
    (SELECT SUM(data_format_0) as b 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Dom_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum2,
    (SELECT SUM(data_format_0) as c 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Softwater_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum3,
    (SELECT SUM(data_format_0) as d 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Boiler_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum4,
    (SELECT SUM(data_format_0) as e 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Inlet_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum5,
    (SELECT SUM(data_format_0) as f 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Outlet_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum6,
    (SELECT SUM(data_format_0) as g 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_RO_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum7,
    (SELECT SUM(data_format_0) as h 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Chiller_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum8,
    (SELECT SUM(data_format_0) as i 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Taman_sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum9,
    (SELECT SUM(data_format_0) as j 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum10,
    (SELECT SUM(data_format_0) as k 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum11,
    (SELECT SUM(data_format_0) as l 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum12,
    (SELECT SUM(data_format_0) as m 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_CIP_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum13,
    (SELECT SUM(data_format_0) as n 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum14,
    (SELECT SUM(data_format_0) as o 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Lab_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum15,
    (SELECT SUM(data_format_0) as p 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum16,
    (SELECT SUM(data_format_0) as q 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum17,
    (SELECT SUM(data_format_0) as r 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Workshop_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum18,
    (SELECT SUM(data_format_0) as s 
         FROM parammachine_saka.\`cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` WHERE
    date(FROM_UNIXTIME(\`time@timestamp\`) ) BETWEEN '${start}' AND '${finish}' ) as sum19`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Consumption Daily Backend
  ExportWaterConsumptionDaily: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y') AS Tanggal,
    round(d.data_format_0,2) as Domestik,
    round(c.data_format_0,2) as Chiller,
    round(s.data_format_0,2) as Softwater,
    round(b.data_format_0,2) as Boiler,
    round(ip.data_format_0,2) as Inlet_Pretreatment,
    round(op.data_format_0,2) as Outlet_Pretreatment,
    round(ro.data_format_0,2) as Reject_Osmotron,
    round(t.data_format_0,2) as Taman,
    round(iwk.data_format_0,2) as Inlet_WWTP_Kimia,
    round(iwb.data_format_0,2) as Inlet_WWTP_Biologi,
    round(ow.data_format_0,2) as Outlet_WWTP,
    round(cip.data_format_0,2) as CIP,
    round(h.data_format_0,2) as Hotwater,
    round(l.data_format_0,2) as Lab,
    round(atl.data_format_0,2) as Atas_Toilet_Lt2,
    round(atlq.data_format_0,2) as Atas_Lab_QC,
    round(w.data_format_0,2) as Workshop,
    round(os.data_format_0,2) as Osmotron,
    round(lo.data_format_0,2) as Loopo,
    round(p.data_format_0,2) as Produksi,
    round(wa.data_format_0,2) as washing,
    round(l1.data_format_0,2) as lantai1,
    round(pd.data_format_0,2) as pdam
         \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Dom_sehari_data\` as d
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Chiller_sehari_data\` as c on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Softwater_sehari_data\` as s on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Boiler_sehari_data\` as b on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Inlet_Sehari_data\` as ip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Outlet_sehari_data\` as op on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_RO_sehari_data\` as ro on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Taman_sehari_data\` as t on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` as iwk on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` as iwb on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` as ow on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_CIP_Sehari_data\` as cip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` as h on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lab_Sehari_data\` as l on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` as atl on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` as atlq on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Workshop_Sehari_data\` as w on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` as am on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Osmotron_Sehari_data\` as os on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Loopo_Sehari_data\` as lo on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Produksi_Sehari_data\` as p on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Washing_Sehari_data\` as wa on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lantai1_Sehari_data\` as l1 on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_PDAM_Sehari_data\` as pd on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
    where  date(FROM_UNIXTIME(d.\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' 
    order by date(FROM_UNIXTIME(d.\`time@timestamp\`));`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Totalizer Daily Backend
  ExportWaterTotalizerDaily: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y') AS Tanggal,
    round(d.data_format_0,2) as Domestik,
    round(c.data_format_0,2) as Chiller,
    round(s.data_format_0,2) as Softwater,
    round(b.data_format_0,2) as Boiler,
    round(ip.data_format_0,2) as Inlet_Pretreatment,
    round(op.data_format_0,2) as Outlet_Pretreatment,
    round(ro.data_format_0,2) as Reject_Osmotron,
    round(t.data_format_0,2) as Taman,
    round(iwk.data_format_0,2) as Inlet_WWTP_Kimia,
    round(iwb.data_format_0,2) as Inlet_WWTP_Biologi,
    round(ow.data_format_0,2) as Outlet_WWTP,
    round(cip.data_format_0,2) as CIP,
    round(h.data_format_0,2) as Hotwater,
    round(l.data_format_0,2) as Lab,
    round(atl.data_format_0,2) as Atas_Toilet_Lt2,
    round(atlq.data_format_0,2) as Atas_Lab_QC,
    round(w.data_format_0,2) as Workshop,
    round(am.data_format_0,2) as Air_Mancur,
    round(os.data_format_0,2) as Osmotron,
    round(lo.data_format_0,2) as Loopo,
    round(p.data_format_0,2) as Produksi,
    round(wa.data_format_0,2) as washing,
    round(l1.data_format_0,2) as lantai1,
    round(pd.data_format_0,2) as pdam
         \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` as d
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Chiller_data\` as c on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Softwater_data\` as s on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Boiler_data\` as b on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Inlet_Pt_data\` as ip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Outlet_Pt_data\` as op on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_RO_data\` as ro on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Taman_data\` as t on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_data\` as iwk on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_data\` as iwb on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_data\` as ow on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_CIP_data\` as cip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Hotwater_data\` as h on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lab_data\` as l on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Toilet2_data\` as atl on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Lab QC_data\` as atlq on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Workshop_data\` as w on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Air Mancur_data\` as am on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Osmotron_data\` as os on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Loopo_data\` as lo on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Produksi_data\` as p on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Washing_data\` as wa on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lantai1_data\` as l1 on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_PDAM_data\` as pd on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
    where  date(FROM_UNIXTIME(d.\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Consumption Daily Backend
  ExportWaterConsumptionMonthly: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%m-%Y') AS Bulan,
    sum(round(d.data_format_0,2)) as Domestik,
    sum(round(c.data_format_0,2)) as Chiller,
    sum(round(s.data_format_0,2)) as Softwater,
    sum(round(b.data_format_0,2)) as Boiler,
    sum(round(ip.data_format_0,2)) as Inlet_Pretreatment,
    sum(round(op.data_format_0,2)) as Outlet_Pretreatment,
    sum(round(ro.data_format_0,2)) as Reject_Osmotron,
    sum(round(t.data_format_0,2)) as Taman,
    sum(round(iwk.data_format_0,2)) as Inlet_WWTP_Kimia,
    sum(round(iwb.data_format_0,2)) as Inlet_WWTP_Biologi,
    sum(round(ow.data_format_0,2)) as Outlet_WWTP,
    sum(round(cip.data_format_0,2)) as CIP,
    sum(round(h.data_format_0,2)) as Hotwater,
    sum(round(l.data_format_0,2)) as Lab,
    sum(round(atl.data_format_0,2)) as Atas_Toilet_Lt2,
    sum(round(atlq.data_format_0,2)) as Atas_Lab_QC,
    sum(round(w.data_format_0,2)) as Workshop,
    sum(round(am.data_format_0,2)) as Air_Mancur,
    sum(round(os.data_format_0,2))as Osmotron,
    sum(round(lo.data_format_0,2)) as Loopo,
    sum(round(p.data_format_0,2)) as Produksi,
    sum(round(wa.data_format_0,2)) as washing,
    sum(round(l1.data_format_0,2)) as lantai1,
    sum(round(pd.data_format_0,2)) as pdam
         \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Dom_sehari_data\` as d
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Chiller_sehari_data\` as c on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Softwater_sehari_data\` as s on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Boiler_sehari_data\` as b on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Inlet_Sehari_data\` as ip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Outlet_sehari_data\` as op on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_RO_sehari_data\` as ro on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Taman_sehari_data\` as t on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` as iwk on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` as iwb on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` as ow on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_CIP_Sehari_data\` as cip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` as h on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lab_Sehari_data\` as l on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` as atl on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` as atlq on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Workshop_Sehari_data\` as w on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` as am on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Osmotron_Sehari_data\` as os on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Loopo_Sehari_data\` as lo on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Produksi_Sehari_data\` as p on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Washing_Sehari_data\` as wa on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lantai1_Sehari_data\` as l1 on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_PDAM_Sehari_data\` as pd on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
    where  DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m') BETWEEN '${start}' AND '${finish}' 
    GROUP BY YEAR(date(FROM_UNIXTIME(d.\`time@timestamp\`))), 
    MONTH(date(FROM_UNIXTIME(d.\`time@timestamp\`)))`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Totalizer Monthly Backend
  ExportWaterTotalizerMonthly: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%m-%Y') AS Bulan,
    round(d.data_format_0,2) as Domestik,
    round(c.data_format_0,2) as Chiller,
    round(s.data_format_0,2) as Softwater,
    round(b.data_format_0,2) as Boiler,
    round(ip.data_format_0,2) as Inlet_Pretreatment,
    round(op.data_format_0,2) as Outlet_Pretreatment,
    round(ro.data_format_0,2) as Reject_Osmotron,
    round(t.data_format_0,2) as Taman,
    round(iwk.data_format_0,2) as Inlet_WWTP_Kimia,
    round(iwb.data_format_0,2) as Inlet_WWTP_Biologi,
    round(ow.data_format_0,2) as Outlet_WWTP,
    round(cip.data_format_0,2) as CIP,
    round(h.data_format_0,2) as Hotwater,
    round(l.data_format_0,2) as Lab,
    round(atl.data_format_0,2) as Atas_Toilet_Lt2,
    round(atlq.data_format_0,2) as Atas_Lab_QC,
    round(w.data_format_0,2) as Workshop,
    round(am.data_format_0,2) as Air_Mancur,
    round(os.data_format_0,2) as Osmotron,
    round(lo.data_format_0,2) as Loopo,
    round(p.data_format_0,2) as Produksi,
    round(wa.data_format_0,2) as washing,
    round(l1.data_format_0,2) as lantai1,
    round(pd.data_format_0,2) as pdam
    FROM (Select
      max(DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y')) as Tgld,
      d.data_index as id
           \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` as d 
      GROUP BY YEAR(date(FROM_UNIXTIME(d.\`time@timestamp\`))), 
      MONTH(date(FROM_UNIXTIME(d.\`time@timestamp\`)))) as tgl,
          parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` as d
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Chiller_data\` as c on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Softwater_data\` as s on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Boiler_data\` as b on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Inlet_Pt_data\` as ip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Outlet_Pt_data\` as op on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_RO_data\` as ro on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Taman_data\` as t on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_data\` as iwk on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_data\` as iwb on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_data\` as ow on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_CIP_data\` as cip on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Hotwater_data\` as h on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lab_data\` as l on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Toilet2_data\` as atl on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Lab QC_data\` as atlq on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Workshop_data\` as w on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Air Mancur_data\` as am on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Osmotron_data\` as os on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Loopo_data\` as lo on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Produksi_data\` as p on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Washing_data\` as wa on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lantai1_data\` as l1 on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
          left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_PDAM_data\` as pd on 
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
    where DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y') = Tgld and
    DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m') BETWEEN '${start}' AND '${finish}'`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Consumption Yearly Backend
  ExportWaterConsumptionYearly: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y') AS Tahun,
      sum(round(d.data_format_0,2)) as Domestik,
      sum(round(c.data_format_0,2)) as Chiller,
      sum(round(s.data_format_0,2)) as Softwater,
      sum(round(b.data_format_0,2)) as Boiler,
      sum(round(ip.data_format_0,2)) as Inlet_Pretreatment,
      sum(round(op.data_format_0,2)) as Outlet_Pretreatment,
      sum(round(ro.data_format_0,2)) as Reject_Osmotron,
      sum(round(t.data_format_0,2)) as Taman,
      sum(round(iwk.data_format_0,2)) as Inlet_WWTP_Kimia,
      sum(round(iwb.data_format_0,2)) as Inlet_WWTP_Biologi,
      sum(round(ow.data_format_0,2)) as Outlet_WWTP,
      sum(round(cip.data_format_0,2)) as CIP,
      sum(round(h.data_format_0,2)) as Hotwater,
      sum(round(l.data_format_0,2)) as Lab,
      sum(round(atl.data_format_0,2)) as Atas_Toilet_Lt2,
      sum(round(atlq.data_format_0,2)) as Atas_Lab_QC,
      sum(round(w.data_format_0,2)) as Workshop,
      sum(round(am.data_format_0,2)) as Air_Mancur,
      sum(round(os.data_format_0,2))as Osmotron,
      sum(round(lo.data_format_0,2)) as Loopo,
      sum(round(p.data_format_0,2)) as Produksi,
      sum(round(wa.data_format_0,2)) as washing,
      sum(round(l1.data_format_0,2)) as lantai1,
      sum(round(pd.data_format_0,2)) as pdam
           \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Dom_sehari_data\` as d
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Chiller_sehari_data\` as c on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Softwater_sehari_data\` as s on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Boiler_sehari_data\` as b on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Inlet_Sehari_data\` as ip on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Outlet_sehari_data\` as op on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_RO_sehari_data\` as ro on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Taman_sehari_data\` as t on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` as iwk on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` as iwb on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` as ow on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_CIP_Sehari_data\` as cip on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` as h on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lab_Sehari_data\` as l on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` as atl on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` as atlq on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Workshop_Sehari_data\` as w on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` as am on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Osmotron_Sehari_data\` as os on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Loopo_Sehari_data\` as lo on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Produksi_Sehari_data\` as p on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Washing_Sehari_data\` as wa on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Lantai1_Sehari_data\` as l1 on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_PDAM_Sehari_data\` as pd on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
      where  DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y') BETWEEN '${start}' AND '${finish}' 
      GROUP BY YEAR(date(FROM_UNIXTIME(d.\`time@timestamp\`)))`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Export Data Water Totalizer Yearly Backend
  ExportWaterTotalizerYearly: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y') AS Tahun,
      round(d.data_format_0,2) as Domestik,
      round(c.data_format_0,2) as Chiller,
      round(s.data_format_0,2) as Softwater,
      round(b.data_format_0,2) as Boiler,
      round(ip.data_format_0,2) as Inlet_Pretreatment,
      round(op.data_format_0,2) as Outlet_Pretreatment,
      round(ro.data_format_0,2) as Reject_Osmotron,
      round(t.data_format_0,2) as Taman,
      round(iwk.data_format_0,2) as Inlet_WWTP_Kimia,
      round(iwb.data_format_0,2) as Inlet_WWTP_Biologi,
      round(ow.data_format_0,2) as Outlet_WWTP,
      round(cip.data_format_0,2) as CIP,
      round(h.data_format_0,2) as Hotwater,
      round(l.data_format_0,2) as Lab,
      round(atl.data_format_0,2) as Atas_Toilet_Lt2,
      round(atlq.data_format_0,2) as Atas_Lab_QC,
      round(w.data_format_0,2) as Workshop,
      round(am.data_format_0,2) as Air_Mancur,
      round(os.data_format_0,2) as Osmotron,
      round(lo.data_format_0,2) as Loopo,
      round(p.data_format_0,2) as Produksi,
      round(wa.data_format_0,2) as washing,
      round(l1.data_format_0,2) as lantai1,
      round(pd.data_format_0,2) as pdam
      FROM (Select
        max(DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y')) as Tgld,
        d.data_index as id
             \` FROM parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` as d 
        GROUP BY YEAR(date(FROM_UNIXTIME(d.\`time@timestamp\`)))) as tgl,
            parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` as d
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Chiller_data\` as c on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Softwater_data\` as s on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Boiler_data\` as b on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Inlet_Pt_data\` as ip on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ip.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Outlet_Pt_data\` as op on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(op.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_RO_data\` as ro on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ro.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Taman_data\` as t on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(t.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Kimia_data\` as iwk on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwk.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Biologi_data\` as iwb on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(iwb.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_WWTP_Outlet_data\` as ow on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(ow.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_CIP_data\` as cip on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(cip.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Hotwater_data\` as h on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(h.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lab_data\` as l on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Toilet2_data\` as atl on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atl.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Atas Lab QC_data\` as atlq on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(atlq.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Workshop_data\` as w on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(w.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Air Mancur_data\` as am on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(am.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Osmotron_data\` as os on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(os.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Loopo_data\` as lo on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(lo.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Produksi_data\` as p on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(p.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Washing_data\` as wa on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(wa.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_Lantai1_data\` as l1 on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(l1.\`time@timestamp\`), '%Y-%m-%d')
            left join parammachine_saka.\`cMT-DB-WATER-UTY2_Met_PDAM_data\` as pd on 
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d') = DATE_FORMAT(FROM_UNIXTIME(pd.\`time@timestamp\`), '%Y-%m-%d')
      where DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%d-%m-%Y') = Tgld and
      DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y') BETWEEN '${start}' AND '${finish}'`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Power Management 2 Backend
  PowerDaily: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
    s1.data_index as x,
    DATE_FORMAT(FROM_UNIXTIME(s1.\`time@timestamp\`) , '%Y-%m-%d') AS label,
    round(s1.data_format_0 -
      (select s2.data_format_0 as previous from
      ems_saka.\`${area}\` as s2
      where s2.data_index < s1.data_index and s2.data_format_0 > 0 order by s2.data_index  desc limit 1),2) as y
    From ems_saka.\`${area}\` as s1 
    WHERE date(FROM_UNIXTIME(s1.\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' and s1.data_format_0 > 0
    `;

    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },
  // PowerDaily: async (request, response) => {
  //   const { area, start, finish } = request.query;

  //   // Konversi tanggal untuk logika pemilihan database
  //   const startDate = new Date(start);
  //   const finishDate = new Date(finish);
  //   const startYear = startDate.getFullYear();
  //   const finishYear = finishDate.getFullYear();

  //   let queryGet;
  //   let db;

  //   if (
  //     startYear === 2024 &&
  //     finishYear === 2024 &&
  //     startDate >= new Date("2024-01-01") &&
  //     finishDate <= new Date("2024-07-15")
  //   ) {
  //     // Jika tanggal antara 1 Januari 2024 - 15 Juli 2024, gunakan db3
  //     db = db3;
  //     queryGet = `
  //     SELECT
  //       data_index AS x,
  //       data_format_0 AS y,
  //       DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR, '%Y-%m-%d') AS label
  //     FROM \`parammachine_saka\`.\`${area}\`
  //     WHERE date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
  //     AND data_format_0 > 0
  //     ORDER BY data_index;
  //   `;
  //   } else if (
  //     startYear === 2024 &&
  //     finishYear === 2024 &&
  //     startDate >= new Date("2024-07-16") &&
  //     finishDate <= new Date("2024-12-31")
  //   ) {
  //     // Jika tanggal antara 16 Juli 2024 - 31 Desember 2024, gunakan db4
  //     db = db4;
  //     queryGet = `
  //     SELECT
  //       data_index AS x,
  //       data_format_0 AS y,
  //       DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR, '%Y-%m-%d') AS label
  //     FROM \`ems_saka\`.\`${area}\`
  //     WHERE date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
  //     AND data_format_0 > 0
  //     ORDER BY data_index;
  //   `;
  //   } else {
  //     // Jika input selain di atas (tahun >= 2024), gunakan db4 sebagai default
  //     db = db4;
  //     queryGet = `
  //     SELECT
  //       data_index AS x,
  //       data_format_0 AS y,
  //       DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR, '%Y-%m-%d') AS label
  //     FROM \`ems_saka\`.\`${area}\`
  //     WHERE date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
  //     AND data_format_0 > 0
  //     ORDER BY data_index;
  //   `;
  //   }

  //   // Eksekusi query ke database
  //   db.query(queryGet, (err, result) => {
  //     if (err) {
  //       console.error(err);
  //       return response.status(500).send({ error: "Failed to fetch data" });
  //     }
  //     return response.status(200).send(result);
  //   });
  //   console.log(queryGet);
  // },

  PowerMonthly: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
    s1.\`time@timestamp\`*1000 as x,
    DATE_FORMAT(FROM_UNIXTIME(s1.\`time@timestamp\`) , '%Y-%m') AS label,
    round(sum(s1.data_format_0 -
      (select s2.data_format_0 as previous from
      ems_saka.\`${area}\` as s2
      where s2.data_index < s1.data_index and s2.data_format_0 > 0 order by s2.data_index  desc limit 1)),2) as y
    From ems_saka.\`${area}\` as s1 
    where  DATE_FORMAT(FROM_UNIXTIME(s1.\`time@timestamp\`), '%Y-%m') BETWEEN '${start}' AND '${finish}' and s1.data_format_0 > 0
    GROUP BY YEAR(date(FROM_UNIXTIME(s1.\`time@timestamp\`))), 
    MONTH(date(FROM_UNIXTIME(s1.\`time@timestamp\`)))`;

    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  PowerSankey: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `select MVMDP as "MVMDP",
    lvmdp1 as  "LVMDP1",
    lvmdp2 as  "LVMDP2",
    SP16 as  "SolarPanel16",
    SP712 as  "SolarPanel712",
    utility as  "SDP1Utility",
    utilitylt2 as  "PPLP1UtilityLt2",
    chiller as  "PP1Chiller",
    utilitylt1 as  "PPLP1UtilityLt1",
    genset as "PP1Genset",
    boilerPW as  "PP1BoilerPW",
    kompressor as  "PP1Kompressor",
    HWP as  "PP1HWP",
    pump as  "PP1PUMPS",
    lift as  "PP1Lift",
    ac11 as  "PP1AC11",
    ac12 as  "PP1AC12",
    ac13 as  "PP1AC13",
    ac23 as  "PP1AC23",
    produksi1 as  "SDP1Produksi",
    produksi2 as  "SDP2Produksi",
    hydrant as  "PP2Hydrant",
    puyer as  "PP2Puyer",
    fatigon as  "PP2Fatigon",
    mixagrib as  "PP2Mixagrib",
    lablt2 as  "PP2LabLt2",
    fasilitas as  "PP2Fasilitas",
    packwh as  "PP2PackWH",
    pro11 as  "LP2PRO11",
    pro12 as  "LP2PRO12",
    pro13 as  "LP2PRO13",
    pro23 as  "LP2PRO23",
    pro31 as  "LP2PRO31",
    pro41 as  "LP2PRO41",
    wh11 as  "LP2WH11",
    mezz11 as  "PPLP2Mezz11",
    posjaga1 as  "PPLP1PosJaga1",
    PosJaga2 as  "PPLP1PosJaga2",
    koperasi as  "PPLP1Koperasi",
    gcpgenset as  "GCPGenset",
    sdpgenset as  "SDPGenset",
    chiller1 as  "PPChiller1",
    chiller2 as  "PPChiller2",
    chiller3 as  "PPChiller3",
    ac31rnd as "PP2AC31RND",
    pro31rnd as "LP2PRO31RND"
    from
      (SELECT sum(kwh1) as MVMDP from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl1,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_MVMDP_data\` as s2
		where s2.data_index < l1.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh1 
      from ems_saka.\`cMT-Gedung-UTY_MVMDP_data\` as l1 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'AND data_format_0>0)  as table1
      where kwh1>0) as total1, 

      (SELECT sum(kwh2) as lvmdp1 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl2,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LVMDP1_data\` as s2
		where s2.data_index < l2.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh2
      from ems_saka.\`cMT-Gedung-UTY_LVMDP1_data\` as l2 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table2
      where kwh2>0) as total2, 

      (SELECT sum(kwh3) as lvmdp2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl3,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LVMDP2_data\` as s2
		where s2.data_index < l3.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh3
      from ems_saka.\`cMT-Gedung-UTY_LVMDP2_data\` as l3 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table3
      where kwh3>0) as total3,

      (SELECT sum(kwh4) as SP16 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl4,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_Inverter1-6_SP_data\` as s2
		where s2.data_index < l4.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh4
      from ems_saka.\`cMT-Gedung-UTY_Inverter1-6_SP_data\` as l4 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table4
      where kwh4>0) as total4, 
      
      (SELECT sum(kwh5) as SP712 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl5,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_Inverter7-12_SP_data\` as s2
		where s2.data_index < l5.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh5
      from ems_saka.\`cMT-Gedung-UTY_Inverter7-12_SP_data\` as l5 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table5
      where kwh5>0) as total5, 

      (SELECT sum(kwh6) as utility from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl6,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_SDP.1-Utility_data\` as s2
		where s2.data_index < l6.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh6
      from ems_saka.\`cMT-Gedung-UTY_SDP.1-Utility_data\` as l6 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table6
      where kwh6>0) as total6, 

      (SELECT sum(kwh7) as utilitylt2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl7,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.2_data\` as s2
		where s2.data_index < l7.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh7
      from ems_saka.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.2_data\` as l7 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table7
      where kwh7>0) as total7, 

      (SELECT sum(kwh8) as chiller from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl8,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-Chiller_data\` as s2
		where s2.data_index < l8.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh8
      from ems_saka.\`cMT-Gedung-UTY_PP.1-Chiller_data\` as l8 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table8
      where kwh8>0) as total8, 

      (SELECT sum(kwh9) as utilitylt1 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl9,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.1_data\` as s2
		where s2.data_index < l9.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh9
      from ems_saka.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.1_data\` as l9 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table9
      where kwh9>0) as total9, 

      (SELECT sum(kwh10) as genset from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl10,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-Genset_data\` as s2
		where s2.data_index < l10.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh10
      from ems_saka.\`cMT-Gedung-UTY_PP.1-Genset_data\` as l10 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table10
      where kwh10>0) as total10, 

      (SELECT sum(kwh11) as boilerPW from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl11,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-Boiler&PW_data\` as s2
		where s2.data_index < l11.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh11
      from ems_saka.\`cMT-Gedung-UTY_PP.1-Boiler&PW_data\` as l11 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table11
      where kwh11>0) as total11, 

      (SELECT sum(kwh12) as kompressor from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl12,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-Kompressor_data\` as s2
		where s2.data_index < l12.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh12
      from ems_saka.\`cMT-Gedung-UTY_PP.1-Kompressor_data\` as l12 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table12
      where kwh12>0) as total12, 

      (SELECT sum(kwh13) as HWP from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl13,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-HWP_data\` as s2
		where s2.data_index < l13.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh13
      from ems_saka.\`cMT-Gedung-UTY_PP.1-HWP_data\` as l13 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table13
      where kwh13>0) as total13, 

      (SELECT sum(kwh14) as pump from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl14,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-PUMPS_data\` as s2
		where s2.data_index < l14.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh14
      from ems_saka.\`cMT-Gedung-UTY_PP.1-PUMPS_data\` as l14 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table14
      where kwh14>0) as total14, 

      (SELECT sum(kwh15) as lift from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl15,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-Lift_data\` as s2
		where s2.data_index < l15.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh15
      from ems_saka.\`cMT-Gedung-UTY_PP.1-Lift_data\` as l15 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table15
      where kwh15>0) as total15, 

      (SELECT sum(kwh16) as ac11 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl16,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.1_data\` as s2
		where s2.data_index < l16.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh16
      from ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.1_data\` as l16 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table16
      where kwh16>0) as total16, 

      (SELECT sum(kwh17) as ac12 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl17,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.2_data\` as s2
		where s2.data_index < l17.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh17
      from ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.2_data\` as l17 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table17
      where kwh17>0) as total17, 

      (SELECT sum(kwh18) as ac13 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl18,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.3_data\` as s2
		where s2.data_index < l18.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh18
      from ems_saka.\`cMT-Gedung-UTY_PP.1-AC1.3_data\` as l18 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table18
      where kwh18>0) as total18, 

      (SELECT sum(kwh19) as ac23 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl19,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.1-AC2.3_data\` as s2
		where s2.data_index < l19.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh19
      from ems_saka.\`cMT-Gedung-UTY_PP.1-AC2.3_data\` as l19 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table19
      where kwh19>0) as total19, 

      (SELECT sum(kwh20) as produksi1 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl20,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_SDP.1-Produksi_data\` as s2
		where s2.data_index < l20.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh20
      from ems_saka.\`cMT-Gedung-UTY_SDP.1-Produksi_data\` as l20 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table20
      where kwh20>0) as total20, 

      (SELECT sum(kwh21) as produksi2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl21,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_SDP.2-Produksi_data\` as s2
		where s2.data_index < l21.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh21
      from ems_saka.\`cMT-Gedung-UTY_SDP.2-Produksi_data\` as l21 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table21
      where kwh21>0) as total21, 

      (SELECT sum(kwh22) as hydrant from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl22,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-Hydrant_data\` as s2
		where s2.data_index < l22.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh22
      from ems_saka.\`cMT-Gedung-UTY_PP.2-Hydrant_data\` as l22 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table22
      where kwh22>0) as total22, 

      (SELECT sum(kwh23) as fatigon from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl23,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-Fatigon_data\` as s2
		where s2.data_index < l23.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh23
      from ems_saka.\`cMT-Gedung-UTY_PP.2-Fatigon_data\` as l23 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table23
      where kwh23>0) as total23, 

      (SELECT sum(kwh24) as puyer from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl24,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-Puyer_data\` as s2
		where s2.data_index < l24.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh24
      from ems_saka.\`cMT-Gedung-UTY_PP.2-Puyer_data\` as l24 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table24
      where kwh24>0) as total24, 

      (SELECT sum(kwh25) as mixagrib from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl25,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-Mixagrib_data\` as s2
		where s2.data_index < l25.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh25
      from ems_saka.\`cMT-Gedung-UTY_PP.2-Mixagrib_data\` as l25 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table25
      where kwh25>0) as total25, 

      (SELECT sum(kwh26) as lablt2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl26,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-LabLt.2_data\` as s2
		where s2.data_index < l26.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh26
      from ems_saka.\`cMT-Gedung-UTY_PP.2-LabLt.2_data\` as l26 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table26
      where kwh26>0) as total26, 

      (SELECT sum(kwh27) as fasilitas from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl27,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-Fasilitas_data\` as s2
		where s2.data_index < l27.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh27
      from ems_saka.\`cMT-Gedung-UTY_PP.2-Fasilitas_data\` as l27 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table27
      where kwh27>0) as total27, 

      (SELECT sum(kwh28) as packwh from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl28,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PP.2-PackWH_data\` as s2
		where s2.data_index < l28.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh28
      from ems_saka.\`cMT-Gedung-UTY_PP.2-PackWH_data\` as l28 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table28
      where kwh28>0) as total28, 

      (SELECT sum(kwh29) as pro11 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl29,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.1_data\` as s2
		where s2.data_index < l29.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh29
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.1_data\` as l29 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table29
      where kwh29>0) as total29, 

      (SELECT sum(kwh30) as pro12 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl30,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.2_data\` as s2
		where s2.data_index < l30.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh30
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.2_data\` as l30 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table30
      where kwh30>0) as total30, 

      (SELECT sum(kwh31) as pro13 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl31,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.3_data\` as s2
		where s2.data_index < l31.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh31
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO1.3_data\` as l31 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table31
      where kwh31>0) as total31, 

      (SELECT sum(kwh32) as pro23 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl32,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO2.3_data\` as s2
		where s2.data_index < l32.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh32
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO2.3_data\` as l32 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table32
      where kwh32>0) as total32, 

      (SELECT sum(kwh33) as pro31 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl33,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO3.1_data\` as s2
		where s2.data_index < l33.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh33
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO3.1_data\` as l33 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table33
      where kwh33>0) as total33, 

      (SELECT sum(kwh34) as pro41 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl34,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2-PRO4.1_data\` as s2
		where s2.data_index < l34.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh34
      from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO4.1_data\` as l34 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table34
      where kwh34>0) as total34, 

      (SELECT sum(kwh35) as wh11 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl35,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2WH1.1_data\` as s2
		where s2.data_index < l35.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh35
      from ems_saka.\`cMT-Gedung-UTY_LP.2WH1.1_data\` as l35 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table35
      where kwh35>0) as total35, 

      (SELECT sum(kwh36) as mezz11 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl36,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_LP.2MEZZ1.1_data\` as s2
		where s2.data_index < l36.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh36
      from ems_saka.\`cMT-Gedung-UTY_LP.2MEZZ1.1_data\` as l36 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table36
      where kwh36>0) as total36, 

      (SELECT sum(kwh37) as posjaga1 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl37,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PPLP.2-PosJaga1_data\` as s2
		where s2.data_index < l37.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh37
      from ems_saka.\`cMT-Gedung-UTY_PPLP.2-PosJaga1_data\` as l37 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table37
      where kwh37>0) as total37, 

      (SELECT sum(kwh38) as PosJaga2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl38,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PPLP.2-PosJaga2_data\` as s2
		where s2.data_index < l38.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh38
      from ems_saka.\`cMT-Gedung-UTY_PPLP.2-PosJaga2_data\` as l38 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table38
      where kwh38>0) as total38, 

      (SELECT sum(kwh40) as koperasi from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl40,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_PPLP.2-Koperasi_data\` as s2
		where s2.data_index < l40.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh40
      from ems_saka.\`cMT-Gedung-UTY_PPLP.2-Koperasi_data\` as l40 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table40
      where kwh40>0) as total40, 

      (SELECT sum(kwh41) as gcpgenset from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl41,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_GCP_Genset_data\` as s2
		where s2.data_index < l41.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh41
      from ems_saka.\`cMT-Gedung-UTY_GCP_Genset_data\` as l41 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table41
      where kwh41>0) as total41, 

      (SELECT sum(kwh42) as sdpgenset from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl42,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_SDP_Genset_data\` as s2
		where s2.data_index < l42.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh42
      from ems_saka.\`cMT-Gedung-UTY_SDP_Genset_data\` as l42 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table42
      where kwh42>0) as total42, 

      (SELECT sum(kwh47) as chiller1 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl47,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_Chiller1_data\` as s2
		where s2.data_index < l47.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh47
      from ems_saka.\`cMT-Gedung-UTY_Chiller1_data\` as l47 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table47
      where kwh47>0) as total47, 

      (SELECT sum(kwh48) as chiller2 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl48,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_Chiller2_data\` as s2
		where s2.data_index < l48.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh48
      from ems_saka.\`cMT-Gedung-UTY_Chiller2_data\` as l48 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table48
      where kwh48>0) as total48, 

      (SELECT sum(kwh49) as chiller3 from (SELECT
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl49,
      data_format_0-(select s2.data_format_0 as previous from
		ems_saka.\`cMT-Gedung-UTY_Chiller3_data\` as s2
		where s2.data_index < l49.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh49
      from ems_saka.\`cMT-Gedung-UTY_Chiller3_data\` as l49 WHERE
      date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table49
      where kwh49>0) as total49,

      (SELECT sum(kwh50) as ac31rnd from (SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl50,
        data_format_0-(select s2.data_format_0 as previous from
      ems_saka.\`cMT-Gedung-UTY_PP.2-AC 3.1 RND_data\` as s2
      where s2.data_index < l50.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh50
        from ems_saka.\`cMT-Gedung-UTY_PP.2-AC 3.1 RND_data\` as l50 WHERE
        date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}' AND data_format_0>0)  as table50
        where kwh50>0) as total50,

        (SELECT sum(kwh51) as pro31rnd from (SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) , '%Y-%m-%d') AS tgl51,
          data_format_0-(select s2.data_format_0 as previous from
        ems_saka.\`cMT-Gedung-UTY_LP.2-PRO 3.1 RND_data\` as s2
        where s2.data_index < l51.data_index and s2.data_format_0 order by s2.data_index  desc limit 1) as kwh51
          from ems_saka.\`cMT-Gedung-UTY_LP.2-PRO 3.1 RND_data\` as l51 WHERE
          date(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '2024-06-01' AND '2024-06-05' AND data_format_0>0)  as table51
          where kwh51>0) as total51
    `;

    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },
  // Purified Water Backend
  PurifiedWater: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4  HOUR, '%Y-%m-%d %H:%i') AS label,
        data_index AS x,
        round(data_format_0,2) AS y
        FROM \`${area}\`
        WHERE
          DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        ORDER BY
        \`time@timestamp\``;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Chiller Chart Backend
  ChillerGraph: async (request, response) => {
    const { area, start, finish, chiller, komp } = request.query;

    const areaFormatted = area.replace(/[-.]/g, "_");

    const queryGet = `
            SELECT
                DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) - INTERVAL 6 HOUR, '%Y-%m-%d %H:%i') AS label,
                \`time@timestamp\` * 1000 AS x,
                data_format_0 AS y
            FROM
                \`newdb\`.\`${areaFormatted}${komp}${chiller}_data\`
            WHERE
                DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) - INTERVAL 6 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'

            UNION ALL

            SELECT
                DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) - INTERVAL 6 HOUR, '%Y-%m-%d %H:%i') AS label,
                \`time@timestamp\` * 1000 AS x,
                data_format_0 AS y
            FROM
                \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_${area}${komp}${chiller}_data\`
            WHERE
                DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) - INTERVAL 6 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'

            ORDER BY
                x;
        `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        return response.status(500).send(err);
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Status Backend
  ChillerStatus: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;
    
    const queryGet = `
    SELECT * FROM (
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 6 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
        CASE WHEN a.data_format_0 = 0 THEN "OFF" WHEN a.data_format_0 = 1 THEN "ON" END AS Alarm_Chiller,
        CASE WHEN a1.data_format_0 = 0 THEN "OFF" WHEN a1.data_format_0 = 1 THEN "ON" END AS Status_Chiller,
        CASE WHEN f.data_format_0 = 0 THEN "OFF" WHEN f.data_format_0 = 1 THEN "ON" END AS Fan_Kondensor,
        CASE WHEN d.data_format_0 = 0 THEN "OFF" WHEN d.data_format_0 = 1 THEN "ON" END AS Status_Kompresor
        
      FROM
        \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS a
      LEFT JOIN
        \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusCH${chiller}_data\` AS a1
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      LEFT JOIN
        \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-StatFanKondCH${chiller}_data\` AS f
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(f.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      LEFT JOIN
        \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-Status${komp}${chiller}_data\` AS d
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      WHERE 
        DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 6 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
      UNION ALL
  
      SELECT
        DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 6 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
        CASE WHEN a.data_format_0 = 0 THEN "OFF" WHEN a.data_format_0 = 1 THEN "ON" END AS Alarm_Chiller,
        CASE WHEN a1.data_format_0 = 0 THEN "OFF" WHEN a1.data_format_0 = 1 THEN "ON" END AS Status_Chiller,
        CASE WHEN f.data_format_0 = 0 THEN "OFF" WHEN f.data_format_0 = 1 THEN "ON" END AS Fan_Kondensor,
        CASE WHEN d.data_format_0 = 0 THEN "OFF" WHEN d.data_format_0 = 1 THEN "ON" END AS Status_Kompresor
        
      FROM
        \`newdb\`.\`R_AlarmCH${chiller}_data\` AS a
      LEFT JOIN
        \`newdb\`.\`R_StatusCH${chiller}_data\` AS a1
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      LEFT JOIN
        \`newdb\`.\`H_StatFanKondCH${chiller}_data\` AS f
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(f.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      LEFT JOIN
        \`newdb\`.\`R_Status${komp}${chiller}_data\` AS d
        ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(d.\`time@timestamp\`), '%Y-%m-%d %H:%i')
      WHERE 
        DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 6 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
    ) AS combined
    ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Status Backend
  ChillerKondisi: async (request, response) => {
    const { start, finish, chiller, komp, oliats } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          CASE WHEN b.data_format_0 = 0 THEN "Kotor" WHEN b.data_format_0 = 1 THEN "Bersih" END AS Bodi_Chiller,
          CASE WHEN c.data_format_0 = 0 THEN "Kotor" WHEN c.data_format_0 = 1 THEN "Bersih" END AS KisiKisi_Kondensor,
          CASE
            WHEN y.data_format_0 = 4 THEN "0%"
            WHEN y.data_format_0 = 0 THEN "25%"
            WHEN y.data_format_0 = 1 THEN "50%"
            WHEN y.data_format_0 = 2 THEN "75%"
            WHEN y.data_format_0 = 3 THEN "100%"
          END AS Lvl_Oil_Sight_Glass_Atas,
          CASE
            WHEN z.data_format_0 = 4 THEN "0%"
            WHEN z.data_format_0 = 0 THEN "25%"
            WHEN z.data_format_0 = 1 THEN "50%"
            WHEN z.data_format_0 = 2 THEN "75%"
            WHEN z.data_format_0 = 3 THEN "100%"
          END AS Lvl_Oil_Sight_Glass_Bawah,
          CASE
            WHEN aa.data_format_0 = 0 THEN "Clear"
            WHEN aa.data_format_0 = 1 THEN "Buble"
          END AS Jalur_Sight_Glass_EXP_Valve
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS a
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-BodiChillerCH${chiller}_data\` AS b
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-KisiKondenCH${chiller}_data\` AS c
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-${oliats}Ats${komp}${chiller}_data\` AS y
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(y.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-OliGlsBwh${komp}${chiller}_data\` AS z
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(z.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-GlsExpVlv${komp}${chiller}_data\` AS aa
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(aa.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          CASE WHEN b.data_format_0 = 0 THEN "Kotor" WHEN b.data_format_0 = 1 THEN "Bersih" END AS Bodi_Chiller,
          CASE WHEN c.data_format_0 = 0 THEN "Kotor" WHEN c.data_format_0 = 1 THEN "Bersih" END AS KisiKisi_Kondensor,
          CASE
            WHEN y.data_format_0 = 4 THEN "0%"
            WHEN y.data_format_0 = 0 THEN "25%"
            WHEN y.data_format_0 = 1 THEN "50%"
            WHEN y.data_format_0 = 2 THEN "75%"
            WHEN y.data_format_0 = 3 THEN "100%"
          END AS Lvl_Oil_Sight_Glass_Atas,
          CASE
            WHEN z.data_format_0 = 4 THEN "0%"
            WHEN z.data_format_0 = 0 THEN "25%"
            WHEN z.data_format_0 = 1 THEN "50%"
            WHEN z.data_format_0 = 2 THEN "75%"
            WHEN z.data_format_0 = 3 THEN "100%"
          END AS Lvl_Oil_Sight_Glass_Bawah,
          CASE
            WHEN aa.data_format_0 = 0 THEN "Clear"
            WHEN aa.data_format_0 = 1 THEN "Buble"
          END AS Jalur_Sight_Glass_EXP_Valve
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS a
        LEFT JOIN
          newdb.\`H_BodiChillerCH${chiller}_data\` AS b
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_KisiKondenCH${chiller}_data\` AS c
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(c.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_${oliats}Ats${komp}${chiller}_data\` AS y
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(y.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_OliGlsBwh${komp}${chiller}_data\` AS z
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(z.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_GlsExpVlv${komp}${chiller}_data\` AS aa
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(aa.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Nama Backend
  ChillerNama: async (request, response) => {
    const { start, finish, chiller } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          CASE
            WHEN s.data_format_0 = 0 THEN "Andi"
            WHEN s.data_format_0 = 1 THEN "Toni"
            WHEN s.data_format_0 = 2 THEN "Nur Quraisin"
            WHEN s.data_format_0 = 3 THEN "Jimmy"
          END AS Operator,
          CASE
            WHEN b13.data_format_0 = 0 THEN "Nur Ngaeni"
            WHEN b13.data_format_0 = 1 THEN "Syahrul"
            WHEN b13.data_format_0 = 2 THEN "Yudi"
          END AS Engineer,
          CASE
            WHEN b14.data_format_0 = 0 THEN "Ujang"
            WHEN b14.data_format_0 = 1 THEN "Natan"
          END AS Utility_SPV
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS a
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-NamaOperCH${chiller}_data\` AS s
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-NamaTekCH${chiller}_data\` AS b13
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b13.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-NamaSpvCH${chiller}_data\` AS b14
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b14.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          CASE
            WHEN s.data_format_0 = 0 THEN "Andi"
            WHEN s.data_format_0 = 1 THEN "Toni"
            WHEN s.data_format_0 = 2 THEN "Nur Quraisin"
            WHEN s.data_format_0 = 3 THEN "Jimmy"
          END AS Operator,
          CASE
            WHEN b13.data_format_0 = 0 THEN "Nur Ngaeni"
            WHEN b13.data_format_0 = 1 THEN "Syahrul"
            WHEN b13.data_format_0 = 2 THEN "Yudi"
          END AS Engineer,
          CASE
            WHEN b14.data_format_0 = 0 THEN "Ujang"
            WHEN b14.data_format_0 = 1 THEN "Natan"
          END AS Utility_SPV
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS a
        LEFT JOIN
          newdb.\`H_NamaOperCH${chiller}_data\` AS s
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_NamaTekCH${chiller}_data\` AS b13
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b13.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_NamaSpvCH${chiller}_data\` AS b14
          ON DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(b14.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(a.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 1 Backend
  ChillerData1: async (request, response) => {
    const { start, finish, chiller } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Active_Setpoint",
          a2.data_format_0 AS "Evap_LWT",
          a3.data_format_0 AS "Evap_EWT",
          a4.data_format_0 AS "Unit_Capacity_Full",
          a5.data_format_0 AS "Outdoor_Temperature"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-ActiSetpoiCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvapLWTCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvapEWTCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-UnitCapCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-OutTempCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Active_Setpoint",
          a2.data_format_0 AS "Evap_LWT",
          a3.data_format_0 AS "Evap_EWT",
          a4.data_format_0 AS "Unit_Capacity_Full",
          a5.data_format_0 AS "Outdoor_Temperature"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`R_ActiSetpoiCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_EvapLWTCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_EvapEWTCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_UnitCapCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_OutTempCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 2 Backend
  ChillerData2: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Unit_Capacity_Kompresor",
          a2.data_format_0 AS "Evap_Pressure_Kompresor",
          a3.data_format_0 AS "Cond_Pressure_Kompresor",
          a4.data_format_0 AS "Evap_Sat_Temperature_Kompresor",
          a5.data_format_0 AS "Cond_Sat_Temperature_Kompresor"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-Capacity${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvapPress${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-CondPress${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvapSatTe${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-ConSatTem${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Unit_Capacity_Kompresor",
          a2.data_format_0 AS "Evap_Pressure_Kompresor",
          a3.data_format_0 AS "Cond_Pressure_Kompresor",
          a4.data_format_0 AS "Evap_Sat_Temperature_Kompresor",
          a5.data_format_0 AS "Cond_Sat_Temperature_Kompresor"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`R_Capacity${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_EvapPress${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_CondPress${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_EvapSatTe${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_ConSatTem${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 3 Backend
  ChillerData3: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Suction_Temperature_Kompresor",
          a2.data_format_0 AS "Discharge_Temperature_Kompresor",
          a3.data_format_0 AS "Suction_SH_Kompresor",
          a4.data_format_0 AS "Discharge_SH_Kompresor"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-SuctiTemp${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-DischTemp${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-SuctionSH${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-DischarSH${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Suction_Temperature_Kompresor",
          a2.data_format_0 AS "Discharge_Temperature_Kompresor",
          a3.data_format_0 AS "Suction_SH_Kompresor",
          a4.data_format_0 AS "Discharge_SH_Kompresor"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`R_SuctiTemp${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_DischTemp${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_SuctionSH${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_DischarSH${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 4 Backend
  ChillerData4: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Evap_Approach_Kompresor",
          a2.data_format_0 AS "Evap_Design_Approach_Kompresor",
          a3.data_format_0 AS "Cond_Approach_Kompresor",
          a4.data_format_0 AS "Oil_Pressure_Kompresor",
          a5.data_format_0 AS "Oil_Pressure_Differential_Kompresor"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvapAppro${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EvaDsgApp${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-CondAppro${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-OilPress${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-OilPresDf${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Evap_Approach_Kompresor",
          a2.data_format_0 AS "Evap_Design_Approach_Kompresor",
          a3.data_format_0 AS "Cond_Approach_Kompresor",
          a4.data_format_0 AS "Oil_Pressure_Kompresor",
          a5.data_format_0 AS "Oil_Pressure_Differential_Kompresor"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`R_EvapAppro${komp}${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_EvaDsgApp${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_CondAppro${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_OilPress${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_OilPresDf${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 5 Backend
  ChillerData5: async (request, response) => {
    const { start, finish, chiller, komp, fan } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "EXV_Position_Kompresor",
          a2.data_format_0 AS "Run_Hour_Kompressor",
          a3.data_format_0 AS "Ampere_Kompressor",
          a4.data_format_0 AS "No_Of_Start_Kompresor",
          a5.data_format_0 AS "Total_Fan_ON_Kompresor"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-EXVPositi${komp}2_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-RunHour${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-Ampere${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-No.Start${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-FanOut${fan}${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "EXV_Position_Kompresor",
          a2.data_format_0 AS "Run_Hour_Kompressor",
          a3.data_format_0 AS "Ampere_Kompressor",
          a4.data_format_0 AS "No_Of_Start_Kompresor",
          a5.data_format_0 AS "Total_Fan_ON_Kompresor"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`R_EXVPositi${komp}2_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_RunHour${komp}${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_Ampere${komp}${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`R_No_Start${komp}${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_FanOut${fan}${komp}${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 6 Backend
  ChillerData6: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Tekanan_Return_Chiller",
          round(a2.data_format_0, 2) AS "Tekanan_Supply_Chiller",
          round(a3.data_format_0, 2) AS "Inlet_Softwater",
          a4.data_format_0 AS "Pompa_CHWS_1",
          round(a5.data_format_0, 2) AS "Suhu_sebelum_Pompa_Supply"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-TknReturnCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-TknSupplyCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-InletSoftCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_O-StatONPS${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          a1.data_format_0 AS "Tekanan_Return_Chiller",
          round(a2.data_format_0, 2) AS "Tekanan_Supply_Chiller",
          round(a3.data_format_0, 2) AS "Inlet_Softwater",
          a4.data_format_0 AS "Pompa_CHWS_1",
          round(a5.data_format_0, 2) AS "Suhu_sebelum_Pompa_Supply"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`H_TknReturnCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_TknSupplyCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_InletSoftCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`O_StatONPS${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_ShuSebPmSupCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 7 Backend
  ChillerData7: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Suhu_sesudah_Pompa_Supply",
          round(a2.data_format_0, 2) AS "Tekanan_Sebelum_Pompa_Supply",
          round(a3.data_format_0, 2) AS "Tekanan_Sesudah_Pompa_Supply",
          round(a4.data_format_0, 2) AS "Pompa_CHWR_1",
          round(a5.data_format_0, 2) AS "Suhu_sebelum_Pompa_Return"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-PreSebPmSupCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-PreSesPomSpCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_O-StatONPR${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Suhu_sesudah_Pompa_Supply",
          round(a2.data_format_0, 2) AS "Tekanan_Sebelum_Pompa_Supply",
          round(a3.data_format_0, 2) AS "Tekanan_Sesudah_Pompa_Supply",
          round(a4.data_format_0, 2) AS "Pompa_CHWR_1",
          round(a5.data_format_0, 2) AS "Suhu_sebelum_Pompa_Return"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`H_ShuSesPmSupCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_PreSebPmSupCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_PreSesPomSpCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`O_StatONPR${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_SuhSbPomRetCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 8 Backend
  ChillerData8: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Suhu_sesudah_Pompa_Return",
          round(a2.data_format_0, 2) AS "Tekanan_Sebelum_Pompa_Return",
          round(a3.data_format_0, 2) AS "Tekanan_Sesudah_Pompa_Return",
          round(a4.data_format_0, 2) AS "Tegangan_RS",
          round(a5.data_format_0, 2) AS "Tegangan_ST"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-PreSebPomRtCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-PrSesPomRetCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-TegR-SCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-TegS-TCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Suhu_sesudah_Pompa_Return",
          round(a2.data_format_0, 2) AS "Tekanan_Sebelum_Pompa_Return",
          round(a3.data_format_0, 2) AS "Tekanan_Sesudah_Pompa_Return",
          round(a4.data_format_0, 2) AS "Tegangan_RS",
          round(a5.data_format_0, 2) AS "Tegangan_ST"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`H_SuhSesPmRetCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_PreSebPomRtCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_PrSesPomRetCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`RP_TegR_SCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`RP_TegS_TCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Chiller Data 9 Backend
  ChillerData9: async (request, response) => {
    const { start, finish, chiller, komp } = request.query;

    const queryGet = `
      SELECT * FROM (
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Tegangan_TR",
          round(a2.data_format_0, 2) AS "Ampere_RS",
          round(a3.data_format_0, 2) AS "Ampere_ST",
          round(a4.data_format_0, 2) AS "Ampere_TR",
          round(a5.data_format_0, 2) AS "Grounding_Ampere"
        FROM
          parammachine_saka.\`CMT-DB-Chiller-UTY3_R-AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-TegT-RCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-AmpR-SCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-AmpS-TCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_RP-AmpT-RCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          parammachine_saka.\`CMT-DB-Chiller-UTY3_H-GroundAmperCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
  
        UNION ALL
  
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i:%s') AS time,
          round(a1.data_format_0, 2) AS "Tegangan_TR",
          round(a2.data_format_0, 2) AS "Ampere_RS",
          round(a3.data_format_0, 2) AS "Ampere_ST",
          round(a4.data_format_0, 2) AS "Ampere_TR",
          round(a5.data_format_0, 2) AS "Grounding_Ampere"
        FROM
          newdb.\`R_AlarmCH${chiller}_data\` AS s
        LEFT JOIN
          newdb.\`RP_TegT_RCH${chiller}_data\` AS a1
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a1.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`RP_AmpR_SCH${chiller}_data\` AS a2
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a2.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`RP_AmpS_TCH${chiller}_data\` AS a3
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a3.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`RP_AmpT_RCH${chiller}_data\` AS a4
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a4.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        LEFT JOIN
          newdb.\`H_GroundAmperCH${chiller}_data\` AS a5
          ON DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`), '%Y-%m-%d %H:%i') = DATE_FORMAT(FROM_UNIXTIME(a5.\`time@timestamp\`), '%Y-%m-%d %H:%i')
        WHERE 
          DATE_FORMAT(FROM_UNIXTIME(s.\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
      ) AS combined
      ORDER BY time;
    `;

    //console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Database query error" });
      }
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingRNDSuhu: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000  AS x,
          round(data_format_0,2) AS y
          FROM parammachine_saka.\`${area}\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingRNDDP: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000  AS x,
          round(data_format_2/10,2) AS y
          FROM parammachine_saka.\`${area}\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingRNDRH: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000  AS x,
          round(data_format_1,2) AS y
          FROM parammachine_saka.\`${area}\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingRNDAll: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS tgl,
          round(data_format_0,2) AS temp,
          round(data_format_1,2) AS RH,
          round(data_format_2/10,2) AS DP
          FROM parammachine_saka.\`${area}\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Loopo Chart Backend
  Loopo: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000 AS x,
          round(data_format_0,2) AS y
          FROM parammachine_saka.\`cMT-DB-WATER-UTY2_${area}_data\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\``;
    console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Osmotron Chart Backend
  Osmotron: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000 AS x,
          round(data_format_0,2) AS y
          FROM parammachine_saka.\`cMT-DB-WATER-UTY2_${area}_data\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)- INTERVAL 7 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\``;
    console.log(queryGet);
    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingWH1Suhu: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS label,
        \`time@timestamp\`*1000  AS x,
        round(data_format_0,2) AS y
        FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_${area}_data\`
        WHERE
        DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
        ORDER BY
        \`time@timestamp\`;`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },
  // Building RND RH Backend
  BuildingWH1RH: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS label,
          \`time@timestamp\`*1000  AS x,
          round(data_format_1,2) AS y
          FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_${area}_data\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Building RND Suhu Backend
  BuildingWH1All: async (request, response) => {
    const { area, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d %H:%i') AS tgl,
          round(data_format_0,2) AS temp,
          round(data_format_1,2) AS RH
          FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_${area}_data\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 4 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db3.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  // Alarm List Backend
  AlarmList: async (request, response) => {
    const { type, start, finish } = request.query;
    const queryGet = `SELECT
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 11 HOUR, '%Y-%m-%d %H:%i:%s') AS Tanggal,
          data_format_0 AS Event
          FROM parammachine_saka.\`${type}\`
          WHERE
          DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`)+ INTERVAL 11 HOUR, '%Y-%m-%d') BETWEEN '${start}' AND '${finish}'
          ORDER BY
          \`time@timestamp\`;`;

    db.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============EBR========================================EBR==========================================

  GetDataEBR_PMA: async (request, response) => {
    const { batch, date, machine } = request.query;
    console.log(batch);

    if (machine == "Wetmill") {
      var querryGet = ` SELECT data_index, 
       DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR, '%Y-%m-%d %H:%i:%s') AS label,
       REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(data_format_0 USING utf8), '\0', ''), '\b', ''), '$', ''), CHAR(0x00), '') AS data_format_0_string,
       data_format_1,
       data_format_2,
       data_format_3
FROM ems_saka.\`cMT-FHDGEA1_EBR_${machine}_data\`
WHERE REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(data_format_0 USING utf8), '\0', ''), '\b', ''), '$', ''), CHAR(0x00), '') LIKE '%${batch}%'`;
      console.log("wetmill", querryGet);
    } else {
      var querryGet = ` SELECT data_index, 
      DATE_FORMAT(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR, '%Y-%m-%d %H:%i:%s') AS label,
REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(data_format_0 USING utf8), '\0', ''), '\b', ''), '$', ''), CHAR(0x00), '') AS data_format_0_string,
      REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(data_format_1 USING utf8), '\0', ''), '\b', ''), '$', ''), CHAR(0x00), '') AS data_format_1_string,
      data_format_2,
      data_format_3,
      data_format_4,
      data_format_5,
      data_format_6,
      data_format_7
FROM ems_saka.\`cMT-FHDGEA1_EBR_${machine}_data\`
WHERE REPLACE(REPLACE(REPLACE(REPLACE(CONVERT(data_format_0 USING utf8), '\0', ''), '\b', ''), '$', ''), CHAR(0x00), '') LIKE '%${batch}%'`;
      console.log("yglain", querryGet);
    }

    db2.query(querryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============VIBRATE========================================VIBRATE==========================================

  fetchVibrate: async (request, response) => {
    const tableName = request.query.machine;
    const start = request.query.start;
    const finish = request.query.finish;

    const fetchQuery = `
    SELECT COALESCE(data_index, 0) AS id,
           \`time@timestamp\` AS time,
           data_format_0
    FROM \`${tableName}\`
    WHERE \`time@timestamp\` BETWEEN ${start} AND ${finish}
  `;

    // Fungsi pengecekan tabel di database
    const checkTableExists = (dbConn, machine, callback) => {
      const checkQuery = `SHOW TABLES LIKE '${machine}'`;
      dbConn.query(checkQuery, (err, result) => {
        if (err) return callback(err, false);
        return callback(null, result.length > 0);
      });
    };

    // Cek tabel di DB1
    checkTableExists(db, tableName, (err1, existsInDB1) => {
      if (err1)
        return response
          .status(500)
          .send({ error: "Error checking table in DB1", detail: err1 });

      if (existsInDB1) {
        // Jalankan query di DB1
        db.query(fetchQuery, (err, result) => {
          if (err)
            return response
              .status(500)
              .send({ error: "DB1 query error", detail: err });
          return response.status(200).send(result);
        });
      } else {
        // Cek tabel di DB2
        checkTableExists(db3, tableName, (err2, existsInDB2) => {
          if (err2)
            return response
              .status(500)
              .send({ error: "Error checking table in DB2", detail: err2 });

          if (existsInDB2) {
            // Jalankan query di DB2
            db3.query(fetchQuery, (err, result) => {
              if (err)
                return response
                  .status(500)
                  .send({ error: "DB2 query error", detail: err });
              return response.status(200).send(result);
            });
          } else {
            // Tabel tidak ditemukan di kedua DB
            return response
              .status(404)
              .send({ error: "Table not found in both databases" });
          }
        });
      }
    });
  },

  fetch138: async (request, response) => {
    let fetchQuerry =
      "select * from `cMT-VibrasiHVAC_CMH AHU E 1.01_data` ORDER BY id DESC";
    db3.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  vibrateChart: async (request, response) => {
    const tableName = request.query.machine;
    const start = request.query.start;
    const finish = request.query.finish;

    const fetchQuery = `
      SELECT COALESCE(data_index, 0) AS x,
            \`time@timestamp\` AS label,
            data_format_0 AS y
      FROM \`${tableName}\`
      WHERE \`time@timestamp\` BETWEEN ${start} AND ${finish}
    `;

    const checkTableExists = (dbConn, machine, callback) => {
      const checkQuery = `SHOW TABLES LIKE '${machine}'`;
      dbConn.query(checkQuery, (err, result) => {
        if (err) return callback(err, false);
        return callback(null, result.length > 0);
      });
    };

    // Cek tabel di DB1
    checkTableExists(db, tableName, (err1, existsInDB1) => {
      if (err1)
        return response
          .status(500)
          .send({ error: "Error checking table in DB1", detail: err1 });

      if (existsInDB1) {
        // Jalankan query di DB1
        db.query(fetchQuery, (err, result) => {
          if (err)
            return response
              .status(500)
              .send({ error: "DB1 query error", detail: err });
          return response.status(200).send(result);
        });
      } else {
        // Cek tabel di DB2
        checkTableExists(db3, tableName, (err2, existsInDB2) => {
          if (err2)
            return response
              .status(500)
              .send({ error: "Error checking table in DB2", detail: err2 });

          if (existsInDB2) {
            // Jalankan query di DB2
            db3.query(fetchQuery, (err, result) => {
              if (err)
                return response
                  .status(500)
                  .send({ error: "DB2 query error", detail: err });
              return response.status(200).send(result);
            });
          } else {
            // Tabel tidak ditemukan di kedua DB
            return response
              .status(404)
              .send({ error: "Table not found in both databases" });
          }
        });
      }
    });
  },

  trialChiller: async (request, response) => {
    let fetchQuerry = "select * from `CMT-Chiller_H-BodiChillerCH1_data`";
    db3.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============INSTRUMENT IPC ========================================INSTRUMENT IPC==========================================

  getMoistureData: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT * FROM sakaplant_prod_ipc_ma_staging 
    WHERE created_date BETWEEN '${start}' AND '${finish}'
    ORDER BY id_setup ASC;`;
    db4.query(queryGet, (err, result) => {
      console.log(queryGet);
      return response.status(200).send(result);
    });
  },

  getMoistureGraph: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
      SELECT
      created_date AS label,
      id_setup AS x, 
      end_weight AS y 
      FROM sakaplant_prod_ipc_ma_staging
      WHERE created_date BETWEEN '${start}' AND '${finish}'
      ORDER BY id_setup ASC;`;

    console.log(queryGet);
    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getSartoriusData: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT * FROM sakaplant_prod_ipc_scale_staging 
    WHERE DATE(created_date) 
    BETWEEN '${start}' AND '${finish}' 
    ORDER BY id_setup ASC;`;
    console.log(queryGet);

    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getSartoriusGraph: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
    SELECT 
      created_date AS label, 
      id_setup AS x, 
      scale_weight AS y 
    FROM sakaplant_prod_ipc_scale_staging 
    WHERE DATE(created_date) 
    BETWEEN '${start}' AND '${finish}' 
    ORDER BY id_setup ASC;

  `;
    db4.query(queryGet, (err, result) => {
      if (err) {
        console.error(err);
        return response.status(500).send({ error: "Failed to fetch data" });
      }
      return response.status(200).send(result);
    });
  },

  getMettlerData: async (request, response) => {
    let fetchQuerry = "select * from `Mettler_Scales`";
    db4.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============INSTRUMENT HARDNESS 141 ========================================INSTRUMENT HARDNESS 141 ==========================================
  getHardnessData: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT * FROM ipc_hardness 
      WHERE created_date BETWEEN '${start}' AND '${finish}'
      ORDER BY id ASC;`;
    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getHardnessGraph: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT
          CONCAT(DATE(created_date), ' ', TIME(time_insert)) AS label,
          id AS x, 
          h_value AS y 
          FROM ipc_hardness 
          WHERE created_date BETWEEN '${start}' AND '${finish}'
          ORDER BY id ASC;`;
    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getThicknessGraph: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT
          CONCAT(DATE(created_date), ' ', TIME(time_insert)) AS label,
          id AS x, 
          t_value AS y 
          FROM ipc_hardness 
          WHERE created_date BETWEEN '${start}' AND '${finish}'
          ORDER BY id ASC;`;
    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  getDiameterGraph: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `SELECT
          CONCAT(DATE(created_date), ' ', TIME(time_insert)) AS label,
          id AS x, 
          d_value AS y 
          FROM ipc_hardness 
          WHERE created_date BETWEEN '${start}' AND '${finish}'
          ORDER BY id ASC;`;
    db4.query(queryGet, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============POWER METER MEZANINE ========================================POWER METER MEZANINE ==========================================

  fetchPower: async (request, response) => {
    let fetchQuerry =
      "SELECT COALESCE(`data_index`, 0) as 'id',`time@timestamp` as 'time', `data_format_0` FROM " +
      " " +
      "`" +
      request.query.machine +
      "`" +
      "WHERE `time@timestamp` BETWEEN" +
      " " +
      request.query.start +
      ` ` +
      "and" +
      ` ` +
      request.query.finish;

    db4.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  PowerMeterGraph: async (request, response) => {
    let fetchQuerry =
      "SELECT COALESCE(`data_index`, 0) as 'x', `time@timestamp` as 'label', `data_format_0` as 'y' FROM " +
      " " +
      "`" +
      request.query.machine +
      "`" +
      "WHERE `time@timestamp` BETWEEN" +
      " " +
      request.query.start +
      ` ` +
      "and" +
      ` ` +
      request.query.finish;

    db4.query(fetchQuerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============BATCH RECORD LINE 1 ========================================BATCH RECORD LINE 1 ==========================================
  PMARecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS label
        FROM 
            \`ems_saka\`.\`cMT-FHDGEA1_EBR_PMA_new_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db4.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  BinderRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`mezanine.tengah_Ebr_Binder1_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  WetmillRecord1: async (request, response) => {
    const { start, finish, data } = request.query;
    const wetArea = "cMT-FHDGEA1_EBR_Wetmill_new_data";

    // If no batch provided, return list of batches (existing behavior)
    if (!data) {
      console.log("[WetmillRecord1] List mode | start:", start, "finish:", finish);
      const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`ems_saka\`.\`${wetArea}\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
      `;
      try {
        const result = await new Promise((resolve, reject) => {
          db4.query(queryGet, (err, result) => {
            if (err) return reject(err);
            resolve(result);
          });
        });
        return response.status(200).send(result);
      } catch (error) {
        console.error(error);
        return response.status(500).send("Database query failed");
      }
    }

    // Batch provided: return detailed rows for that batch
    console.log("[WetmillRecord1] Batch mode | data:", data, "start:", start, "finish:", finish);
    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'ems_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db4.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db4.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find((m) => m.data_format_index === index);
                if (mapping) {
                  return `\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const wetColumns = await getMappedColumns(wetArea, [
        "data_format_0",
        "time@timestamp",
        "data_index",
      ]);

      let where = `CONVERT(\`${wetArea}\`.\`data_format_0\` USING utf8) LIKE ?`;
      const params = [`%${data}%`];
      if (start && finish) {
        where += ` AND DATE(FROM_UNIXTIME(\`${wetArea}\`.\`time@timestamp\`)) BETWEEN ? AND ?`;
        params.push(start, finish);
      }

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(", ")},
          CONVERT(\`data_format_0\` USING utf8) AS WET_BATCH
        FROM \`ems_saka\`.\`${wetArea}\`
        WHERE ${where}
        ORDER BY \`time@timestamp\` ASC;
      `;
      console.log("[WetmillRecord1] Query:\n", query);
      console.log("[WetmillRecord1] Params:", params);

      const result = await new Promise((resolve, reject) => {
        db4.query(query, params, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
      console.log("[WetmillRecord1] Rows:", result?.length || 0);
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },    

  FBDRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`ems_saka\`.\`cMT-FHDGEA1_EBR_FBD_new_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;

    console.log(queryGet);
    try {
      const result = await new Promise((resolve, reject) => {
        db4.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  EPHRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`ems_saka\`.\`cMT-FHDGEA1_EBR_EPH_new_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db4.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  TumblerRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`ems_saka\`.\`cMT-FHDGEA1_EBR_Finalmix_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db2.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  FetteRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`mezanine.tengah_EBR_FetteLine1_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  // DedusterRecord1: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // LifterRecord1: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // MetalDetectorRecord1: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // IJPRecord1: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  HMRecord1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            batchname AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\` / 1000) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`hm_striping_1B\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\` / 1000)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            BATCH
        ORDER BY
            label;
    `;
    db.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  CM1Record1: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`mezanine.tengah_Cm1_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db4.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  PMARecord3: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`cMT-GEA-L3_EBR_PMA_L3_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  // BinderRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db3.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },
  /*
  WetmillRecord3: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`cMT-GEA-L3_EBR_WETMILL_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  }, */

  WetmillRecord3: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT DISTINCT
            data_index AS x, 
            CAST(data_format_0 AS CHAR) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`cMT-GEA-L3_EBR_WETMILL_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        ORDER BY
            label DESC;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

    FBDRecord3: async (request, response) => {
      const { start, finish } = request.query;
      const queryGet = `
          SELECT 
              data_index AS x, 
              CONVERT(data_format_0 USING utf8) AS BATCH,
              DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
          FROM 
              \`parammachine_saka\`.\`cMT-GEA-L3_EBR_FBD_L3_data\`
          WHERE 
              DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
          GROUP BY 
              data_format_0
          ORDER BY
              label;
      `;
      try {
        const result = await new Promise((resolve, reject) => {
          db3.query(queryGet, (err, result) => {
            if (err) {
              return reject(err);
            }
            resolve(result);
          });
        });
        return response.status(200).send(result);
      } catch (error) {
        console.error(error);
        return response.status(500).send("Database query failed");
      }
    },

  EPHRecord3: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            CONVERT(data_format_0 USING utf8) AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\`) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`cMT-GEA-L3_EBR_EPH_L3_data\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            data_format_0
        ORDER BY
            label;
    `;
    try {
      const result = await new Promise((resolve, reject) => {
        db3.query(queryGet, (err, result) => {
          if (err) {
            return reject(err);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed");
    }
  },

  // TumblerRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db2.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // FetteRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // DedusterRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // LifterRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // MetalDetectorRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  // IJPRecord3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },


    // Wetmill New Backend Line 3
  SearchWetmillRecord3: async (request, response) => {
    const { data, start, finish } = request.query;
    if (!data) {
      return response.status(400).send({ error: "Batch data is required" });
    }
    
    const wetArea = "cMT-GEA-L3_EBR_WETMILL_new_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'parammachine_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db3.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db3.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const wetColumns = await getMappedColumns(wetArea, [
        "data_format_0",
        "time@timestamp",
        "data_index",
      ]);

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(", ")},
          CAST(\`data_format_0\` AS CHAR) AS WET_BATCH
        FROM \`parammachine_saka\`.\`${wetArea}\`
        WHERE
          CAST(\`data_format_0\` AS CHAR) LIKE ?
          AND DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN ? AND ?
        ORDER BY \`time@timestamp\` ASC;
      `;

      const result = await new Promise((resolve, reject) => {
        db3.query(query, [`%${data}%`, start, finish], (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed: " + error.message);
    }
  },

  HMRecord3: async (request, response) => {
    const { start, finish } = request.query;
    const queryGet = `
        SELECT 
            data_index AS x, 
            batchname AS BATCH,
            DATE(FROM_UNIXTIME(\`time@timestamp\` / 1000) + INTERVAL 4 HOUR) AS label
        FROM 
            \`parammachine_saka\`.\`hm_striping_1B\`
        WHERE 
            DATE(FROM_UNIXTIME(\`time@timestamp\` / 1000)) BETWEEN '${start}' AND '${finish}'
        GROUP BY 
            BATCH
        ORDER BY
            label;
    `;
    db.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  // CM1Record3: async (request, response) => {
  //   try {
  //     const result = await new Promise((resolve, reject) => {
  //       db4.query(queryGet, (err, result) => {
  //         if (err) {
  //           return reject(err);
  //         }
  //         resolve(result);
  //       });
  //     });
  //     return response.status(200).send(result);
  //   } catch (error) {
  //     console.error(error);
  //     return response.status(500).send("Database query failed");
  //   }
  // },

  //==============SEARCH BATCH RECORD NEW========================================SEARCH BATCH RECORD NEW==========================================

  SearchPMARecord1: async (request, response) => {
    const { data } = request.query;
    const pmaArea = "cMT-FHDGEA1_EBR_PMA_new_data";
    const wetArea = "cMT-FHDGEA1_EBR_Wetmill_new_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'ems_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db4.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db4.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${area}\`.\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${area}\`.\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const [pmaColumns, wetColumns] = await Promise.all([
        getMappedColumns(pmaArea, [
          "data_format_0",
          "data_format_1",
          "time@timestamp",
          "data_index",
        ]),
        getMappedColumns(wetArea, [
          "data_format_0",
          "time@timestamp",
          "data_index",
        ]),
      ]);

      const query = `
        SELECT
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${pmaArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS PMA_time,
          ${pmaColumns.join(",")},
          CONVERT(\`${pmaArea}\`.\`data_format_0\` USING utf8) AS PMA_BATCH,
          CONVERT(\`${pmaArea}\`.\`data_format_1\` USING utf8) AS PMA_PROCESS,

          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${wetArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(",")},
          CONVERT(\`${wetArea}\`.\`data_format_0\` USING utf8) AS WET_PROCESS

        FROM \`ems_saka\`.\`${pmaArea}\`
        LEFT JOIN \`ems_saka\`.\`${wetArea}\`
          ON ABS(\`${pmaArea}\`.\`time@timestamp\` - \`${wetArea}\`.\`time@timestamp\`) <= 60
        WHERE
          CONVERT(\`${pmaArea}\`.\`data_format_0\` USING utf8) LIKE ?
        ORDER BY \`${pmaArea}\`.\`time@timestamp\` ASC;
      `;

      //console.log(query);
      db4.query(query, [`%${data}%`], (err, result) => {
        if (err) {
          console.error(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (err) {
      console.error(err);
      return response.status(500).send("Error combining PMA & WET data");
    }
  },

  SearchWetMillRecord1: async (request, response) => {
    const { data, start, finish } = request.query;
    const wetArea = "cMT-FHDGEA1_EBR_Wetmill_new_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'ems_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db4.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db4.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find((m) => m.data_format_index === index);
                if (mapping) {
                  return `\`${area}\`.\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${area}\`.\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const wetColumns = await getMappedColumns(wetArea, [
        "data_format_0",
        "time@timestamp",
        "data_index",
      ]);

      let where = `CONVERT(\`${wetArea}\`.\`data_format_0\` USING utf8) LIKE ?`;
      const params = [`%${data}%`];
      if (start && finish) {
        where += ` AND DATE(FROM_UNIXTIME(\`${wetArea}\`.\`time@timestamp\`)) BETWEEN ? AND ?`;
        params.push(start, finish);
      }

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${wetArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(", ")},
          CONVERT(\`${wetArea}\`.\`data_format_0\` USING utf8) AS WET_BATCH
        FROM \`ems_saka\`.\`${wetArea}\`
        WHERE ${where}
        ORDER BY \`${wetArea}\`.\`time@timestamp\` ASC;
      `;

      db4.query(query, params, (err, result) => {
        if (err) {
          console.error(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (err) {
      console.error(err);
      return response.status(500).send("Error fetching Wetmill data");
    }
  },

  SearchBinderRecord1: async (request, response) => {
    const { data } = request.query;
    const area = "mezanine.tengah_Ebr_Binder1_data"; // Static value

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'parammachine_saka'
        AND TABLE_NAME = '${area}'
      `;
        db.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
          SELECT
            ${mappedColumns.join(", ")},
            CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`,
            CONVERT(\`data_format_1\` USING utf8) AS \`PROCESS\`
          FROM
            \`parammachine_saka\`.\`${area}\`
          GROUP BY
            \`BATCH\`
          ORDER BY
            MIN(DATE(FROM_UNIXTIME(\`time@timestamp\`))) ASC;
        `;
      db.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  SearchFBDRecord1: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-FHDGEA1_EBR_FBD_new_data"; // Static value

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'ems_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0', 'data_format_1')
      `;
        db4.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db4.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`,
        CONVERT(\`data_format_1\` USING utf8) AS \`PROCESS\`
      FROM
        \`ems_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;

      db4.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  SearchEPHRecord1: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-FHDGEA1_EBR_EPH_new_data"; // Static value

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'ems_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0', 'data_format_1')
      `
      ;
        db4.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db4.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`,
        CONVERT(\`data_format_1\` USING utf8) AS \`PROCESS\`
      FROM
        \`ems_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;

      db4.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  SearchTumblerRecord1: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-FHDGEA1_EBR_Finalmix_data"; // Static value

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'ems_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0')
      `;
        db2.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db2.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`
      FROM
        \`ems_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;

      db2.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  SearchFetteRecord1: async (request, response) => {
    const { data } = request.query;
    const area = "mezanine.tengah_EBR_FetteLine1_data"; // Static value

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'parammachine_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0')
      `;
        db3.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db3.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`
      FROM
        \`parammachine_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;

      db3.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  /* Old Backend PMA3
  SearchPMARecord3: async (request, response) => {
    const { data } = request.query;
    const pmaArea = "cMT-GEA-L3_EBR_PMA_L3_data";
    const wetArea = "cMT-GEA-L3_EBR_WETMILL_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'parammachine_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db3.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db3.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${area}\`.\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${area}\`.\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const [pmaColumns, wetColumns] = await Promise.all([
        getMappedColumns(pmaArea, [
          "data_format_0",
          "data_format_1",
          "time@timestamp",
          "data_index",
        ]),
        getMappedColumns(wetArea, [
          "data_format_0",
          "time@timestamp",
          "data_index",
        ]),
      ]);

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${pmaArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS PMA_time,
          ${pmaColumns.join(",")},
          CONVERT(\`${pmaArea}\`.\`data_format_0\` USING utf8) AS PMA_BATCH,
          CONVERT(\`${pmaArea}\`.\`data_format_1\` USING utf8) AS PMA_PROCESS,

          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${wetArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(",")},
          CONVERT(\`${wetArea}\`.\`data_format_0\` USING utf8) AS WET_PROCESS

        FROM \`parammachine_saka\`.\`${pmaArea}\`
        LEFT JOIN \`parammachine_saka\`.\`${wetArea}\`
          ON ABS(\`${pmaArea}\`.\`time@timestamp\` - \`${wetArea}\`.\`time@timestamp\`) <= 60
        WHERE
          CONVERT(\`${pmaArea}\`.\`data_format_0\` USING utf8) LIKE ?
        ORDER BY \`${pmaArea}\`.\`time@timestamp\` ASC;
      `;

      //console.log(query);
      db3.query(query, [`%${data}%`], (err, result) => {
        if (err) {
          console.error(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (err) {
      console.error(err);
      return response.status(500).send("Error combining PMA & WET data");
    }
  }, 
  */

 SearchPMARecord3: async (request, response) => {
    const { data, start, finish } = request.query;
    console.log("🔍 SearchPMARecord3 DEBUG - Received request");
    console.log("  data:", data);
    console.log("  start:", start);
    console.log("  finish:", finish);
    
    if (!data) {
      console.log("❌ SearchPMARecord3 ERROR - Batch data is required");
      return response.status(400).send({ error: "Batch data is required" });
    }
    
    const pmaArea = "cMT-GEA-L3_EBR_PMA_L3_data";
    const wetArea = "cMT-GEA-L3_EBR_WETMILL_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'parammachine_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        console.log("📋 Fetching columns for:", area);
        db3.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) {
            console.error("❌ Column fetch error:", err);
            return reject(err);
          }
          console.log("  Found columns:", colResults ? colResults.length : 0);
          db3.query(queryMap, (err2, mapResults) => {
            if (err2) {
              console.error("❌ Format mapping error:", err2);
              return reject(err2);
            }
            console.log("  Found mappings:", mapResults ? mapResults.length : 0);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${area}\`.\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${area}\`.\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      console.log("📝 Fetching dynamic columns...");
      const [pmaColumns, wetColumns] = await Promise.all([
        getMappedColumns(pmaArea, [
          "data_format_0",
          "data_format_1",
          "time@timestamp",
          "data_index",
        ]),
        getMappedColumns(wetArea, [
          "data_format_0",
          "time@timestamp",
          "data_index",
        ]),
      ]);
      
      // console.log("✅ Columns fetched successfully");
      // console.log("  PMA columns:", pmaColumns.length);
      // console.log("  WET columns:", wetColumns.length);

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${pmaArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS PMA_time,
          ${pmaColumns.join(", ")},
          CAST(\`${pmaArea}\`.\`data_format_0\` AS CHAR) AS PMA_BATCH,
          CAST(\`${pmaArea}\`.\`data_format_1\` AS CHAR) AS PMA_PROCESS,

          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`${wetArea}\`.\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS WET_time,
          ${wetColumns.join(", ")},
          CAST(\`${wetArea}\`.\`data_format_0\` AS CHAR) AS WET_PROCESS

        FROM \`parammachine_saka\`.\`${pmaArea}\`
        LEFT JOIN \`parammachine_saka\`.\`${wetArea}\`
          ON ABS(\`${pmaArea}\`.\`time@timestamp\` - \`${wetArea}\`.\`time@timestamp\`) <= 60
        WHERE
          CAST(\`${pmaArea}\`.\`data_format_0\` AS CHAR) LIKE ?
          AND DATE(FROM_UNIXTIME(\`${pmaArea}\`.\`time@timestamp\`)) BETWEEN ? AND ?
        ORDER BY \`${pmaArea}\`.\`time@timestamp\` ASC;
      `;

      console.log("📝 SearchPMARecord3 QUERY:");
      console.log(query);
      console.log("📋 Parameters: [%"+data+"%,", start, ",", finish, "]");

      const result = await new Promise((resolve, reject) => {
        console.log("🔌 Executing query with db3 connection...");
        db3.query(query, [`%${data}%`, start, finish], (err, result) => {
          if (err) {
            console.error("❌ Database Error:", err);
            console.error("  Error Code:", err.code);
            console.error("  Error Message:", err.message);
            return reject(err);
          }
          console.log("✅ Query successful! Rows returned:", result ? result.length : 0);
          if (result && result.length > 0) {
            console.log("  First row keys:", Object.keys(result[0]));
            console.log("  First row sample:", result[0]);
          }
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error("❌ SearchPMARecord3 CATCH ERROR:", error);
      return response.status(500).send("Database query failed: " + error.message);
    }
  }, 

  /* FBD3 Old Backend
  SearchFBDRecord3: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-GEA-L3_Data_FBD_L3_data";

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'parammachine_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0')
      `;
        db3.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`
        FROM
        \`parammachine_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;
      db.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  EPH Old Backend
  SearchEPHRecord3: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-GEA-L3_EBR_EPH_L3_data";

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'parammachine_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0')
      `;
        db.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`
        FROM
        \`parammachine_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;
      db.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },
  */

    // FBD New Backend Line 3
    SearchFBDRecord3: async (request, response) => {
    const { data, start, finish } = request.query;
    if (!data) {
      return response.status(400).send({ error: "Batch data is required" });
    }
    
    const fbdArea = "cMT-GEA-L3_EBR_FBD_L3_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'parammachine_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db3.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db3.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const fbdColumns = await getMappedColumns(fbdArea, [
        "data_format_0",
        "time@timestamp",
        "data_index",
      ]);

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS FBD_time,
          ${fbdColumns.join(", ")},
          CAST(\`data_format_0\` AS CHAR) AS FBD_BATCH
        FROM \`parammachine_saka\`.\`${fbdArea}\`
        WHERE
          CAST(\`data_format_0\` AS CHAR) LIKE ?
          AND DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN ? AND ?
        ORDER BY \`time@timestamp\` ASC;
      `;

      const result = await new Promise((resolve, reject) => {
        db3.query(query, [`%${data}%`, start, finish], (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed: " + error.message);
    }
  },

    // EPH New Backend Line 3
  SearchEPHRecord3: async (request, response) => {
    const { data, start, finish } = request.query;
    if (!data) {
      return response.status(400).send({ error: "Batch data is required" });
    }
    
    const ephArea = "cMT-GEA-L3_EBR_EPH_L3_data";

    const getMappedColumns = (area, excludeCols = []) => {
      return new Promise((resolve, reject) => {
        const queryCols = `
          SELECT COLUMN_NAME
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = 'parammachine_saka'
            AND TABLE_NAME = ?
            AND COLUMN_NAME NOT IN (${excludeCols.map(() => "?").join(", ")})
        `;
        const queryMap = `
          SELECT data_format_index, comment FROM \`${area}_format\`
        `;
        db3.query(queryCols, [area, ...excludeCols], (err, colResults) => {
          if (err) return reject(err);
          db3.query(queryMap, (err2, mapResults) => {
            if (err2) return reject(err2);

            const columns = colResults.map(({ COLUMN_NAME }) => {
              const match = COLUMN_NAME.match(/data_format_(\d+)/);
              if (match) {
                const index = parseInt(match[1], 10);
                const mapping = mapResults.find(
                  (m) => m.data_format_index === index
                );
                if (mapping) {
                  return `\`${COLUMN_NAME}\` AS \`${mapping.comment}\``;
                }
              }
              return `\`${COLUMN_NAME}\``;
            });

            resolve(columns);
          });
        });
      });
    };

    try {
      const ephColumns = await getMappedColumns(ephArea, [
        "data_format_0",
        "time@timestamp",
        "data_index",
      ]);

      const query = `
        SELECT 
          DATE_FORMAT(FROM_UNIXTIME(FLOOR(\`time@timestamp\`)), '%Y-%m-%d %H:%i') AS EPH_time,
          ${ephColumns.join(", ")},
          CAST(\`data_format_0\` AS CHAR) AS EPH_BATCH
        FROM \`parammachine_saka\`.\`${ephArea}\`
        WHERE
          CAST(\`data_format_0\` AS CHAR) LIKE ?
          AND DATE(FROM_UNIXTIME(\`time@timestamp\`)) BETWEEN ? AND ?
        ORDER BY \`time@timestamp\` ASC;
      `;

      const result = await new Promise((resolve, reject) => {
        db3.query(query, [`%${data}%`, start, finish], (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });
      return response.status(200).send(result);
    } catch (error) {
      console.error(error);
      return response.status(500).send("Database query failed: " + error.message);
    }
  },

  SearchHMRecord3: async (request, response) => {
    const { data } = request.query;
    const area = "cMT-GEA-L3_EBR_EPH_L3_data";

    const getAllColumns = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'parammachine_saka'
        AND TABLE_NAME = ?
        AND COLUMN_NAME NOT IN ('data_format_0')
      `;
        db.query(query, [area], (err, results) => {
          if (err) return reject(err);
          const columns = results.map((result) => result.COLUMN_NAME);
          resolve(columns);
        });
      });
    };

    const getColumnMappings = () => {
      return new Promise((resolve, reject) => {
        const query = `
        SELECT data_format_index, comment
        FROM \`${area}_format\`
      `;
        db.query(query, (err, results) => {
          if (err) return reject(err);
          resolve(results);
        });
      });
    };

    try {
      const columns = await getAllColumns();
      const columnMappings = await getColumnMappings();

      const mappedColumns = columns.map((col) => {
        const match = col.match(/data_format_(\d+)/);
        if (match) {
          const index = parseInt(match[1], 10);
          const mapping = columnMappings.find(
            (mapping) => mapping.data_format_index === index
          );
          if (mapping) {
            return `\`${col}\` AS \`${mapping.comment}\``;
          }
        }
        return `\`${col}\``;
      });

      const queryGet = `
      SELECT
        ${mappedColumns.join(", ")},
        CONVERT(\`data_format_0\` USING utf8) AS \`BATCH\`
        FROM
        \`parammachine_saka\`.\`${area}\`
      WHERE
        CONVERT(\`data_format_0\` USING utf8) LIKE ?
      ORDER BY
        DATE(FROM_UNIXTIME(\`time@timestamp\`)) ASC;
    `;
      db.query(queryGet, [`%${data}%`], (err, result) => {
        if (err) {
          console.log(err);
          return response.status(500).send("Database query failed");
        }
        return response.status(200).send(result);
      });
    } catch (error) {
      console.log(error);
      return response.status(500).send("Database query failed");
    }
  },

  //==============CRUD CRUD PORTAL========================================CRUD CRUD PORTAL==========================================
  //PARAMETER PORTAL ENJOY

  //create
  CreateParameter: async (request, response) => {
    const {
      Parameter_Air,
      Parameter_Gas,
      Parameter_Listrik,
      Parameter_Air_2,
      Parameter_Gas_2,
      Parameter_Listrik_2,
      Parameter_Out_1,
      Parameter_Out_2,
      Parameter_Out_3,
      Parameter_Out_4,
      Parameter_Out_5,
      Created_date,
      Created_time,
      User,
    } = request.body;

    const insertQuery = `INSERT INTO ems_saka.Parameter_Portal 
                       (Parameter_Air, Parameter_Gas, Parameter_Listrik, Parameter_Air_2, Parameter_Gas_2, Parameter_Listrik_2, 
                        Parameter_Out_1, Parameter_Out_2, Parameter_Out_3, 
                        Parameter_Out_4, Parameter_Out_5, Created_date, Created_time, User) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const insertValues = [
      Parameter_Air,
      Parameter_Gas,
      Parameter_Listrik,
      Parameter_Air_2,
      Parameter_Gas_2,
      Parameter_Listrik_2,
      Parameter_Out_1,
      Parameter_Out_2,
      Parameter_Out_3,
      Parameter_Out_4,
      Parameter_Out_5,
      Created_date,
      Created_time,
      User,
    ];

    db4.query(insertQuery, insertValues, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        // Query untuk fetch data
        const fetchQuery =
          "SELECT * FROM ems_saka.Parameter_Portal ORDER BY id DESC LIMIT 1;";
        db4.query(fetchQuery, (err, result) => {
          if (err) {
            return response.status(400).send(err.message);
          } else {
            return response
              .status(200)
              .send({ message: "Data successfully added" });
          }
        });
      }
    });
  },

  //GET
  GetParameter: async (request, response) => {
    var fatchquerry = `SELECT * FROM ems_saka.Parameter_Portal ORDER BY id DESC LIMIT 1;`;
    // console.log("====================================");
    // console.log("test bro");
    // console.log("====================================");
    db4.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //JAM PORTAL ENJOY

  //create
  CreateJam: async (request, response) => {
    const {
      Jam_Listrik_1,
      Jam_Listrik_2,
      Jam_Listrik_3,
      Jam_Listrik_4,
      Jam_Gas_1,
      Jam_Gas_2,
      Jam_Gas_3,
      Jam_Gas_4,
      Jam_Air_1,
      Jam_Air_2,
      Jam_Air_3,
      Jam_Air_4,
      Created_date,
      Created_time,
      User,
    } = request.body;

    const insertQuery = `INSERT INTO ems_saka.Jam_Portal 
                       (Jam_Listrik_1, Jam_Listrik_2, Jam_Listrik_3, 
                        Jam_Listrik_4, Jam_Gas_1, Jam_Gas_2, Jam_Gas_3, Jam_Gas_4, Jam_Air_1, Jam_Air_2, Jam_Air_3, Jam_Air_4,  
                        Created_date, Created_time, User) 
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const insertValues = [
      Jam_Listrik_1,
      Jam_Listrik_2,
      Jam_Listrik_3,
      Jam_Listrik_4,
      Jam_Gas_1,
      Jam_Gas_2,
      Jam_Gas_3,
      Jam_Gas_4,
      Jam_Air_1,
      Jam_Air_2,
      Jam_Air_3,
      Jam_Air_4,
      Created_date,
      Created_time,
      User,
    ];
    db4.query(insertQuery, insertValues, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        // Query untuk fetch data
        const fetchQuery = "SELECT * FROM ems_saka.Jam_Portal";
        db4.query(fetchQuery, (err, result) => {
          if (err) {
            return response.status(400).send(err.message);
          } else {
            return response
              .status(200)
              .send({ message: "Data successfully added" });
          }
        });
      }
    });
  },

  //GET
  GetJam: async (request, response) => {
    var fatchquerry = `SELECT * FROM ems_saka.Jam_Portal ORDER BY id DESC LIMIT 1;`;

    db4.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //LIMIT PORTAL ENJOY

  //create
  CreateLimit: async (request, response) => {
    const {
      Limit_Listrik,
      Limit_Gas,
      Limit_Air,
      Created_date,
      Created_time,
      User,
    } = request.body;

    const insertQuery = `INSERT INTO ems_saka.Limit_Portal 
                       (Limit_Listrik, Limit_Gas, Limit_Air, 
                        Created_date, Created_time, User) 
                       VALUES (?, ?, ?, ?, ?, ?)`;

    const insertValues = [
      Limit_Listrik,
      Limit_Gas,
      Limit_Air,
      Created_date,
      Created_time,
      User,
    ];
    db4.query(insertQuery, insertValues, (err, result) => {
      if (err) {
        return response.status(400).send(err.message);
      } else {
        // Query untuk fetch data
        const fetchQuery = "SELECT * FROM ems_saka.Limit_Portal";
        db4.query(fetchQuery, (err, result) => {
          if (err) {
            return response.status(400).send(err.message);
          } else {
            return response
              .status(200)
              .send({ message: "Data successfully added" });
          }
        });
      }
    });
  },

  //GET
  GetLimit: async (request, response) => {
    var fatchquerry = `SELECT * FROM ems_saka.Limit_Portal ORDER BY id DESC LIMIT 1;`;

    db4.query(fatchquerry, (err, result) => {
      return response.status(200).send(result);
    });
  },

  //==============TEST VALUE DATA DAILY========================================TEST VALUE DATA DAILY==========================================
  GetDailyVibrasi138: async (request, response) => {
    const fatchquerry = `

    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_2_Current_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_2_Current_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_E1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_E1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_F1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_F1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_F1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_F1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_FT1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_FT1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_G1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_G1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_G1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_G1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_LA2.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_LA2.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_MG1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_MG1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_MG1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_MG1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_WG1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_WG1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_AHU_WG1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_AHU_WG1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_RFU_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_RFU_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Data_RFU_MG1.02_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Data_RFU_MG1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_M_Temp_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_M_Temp_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_X_ACC_G_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_X_ACC_G_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_X_AXISVCF_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_X_AXISVCF_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_X_Axis_Ve_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_X_Axis_Ve_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_XaxisRMS-S1_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_XaxisRMS-S1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Z_ACC_G_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Z_ACC_G_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Z_AXISVCF_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Z_AXISVCF_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_Z_AXIS_RM_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_Z_AXIS_RM_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-VibrasiHVAC_ZaxisRMS-S1_data\` FROM \`parammachine_saka\`.\`cMT-VibrasiHVAC_ZaxisRMS-S1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;

    `;

    db3.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyGedung138: async (request, response) => {
    const fatchquerry = `
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Chiller1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Chiller1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Chiller2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Chiller2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Chiller3_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Chiller3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Fatigon_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Fatigon_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_GCP_Genset_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_GCP_Genset_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Inverter1-6_SP_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Inverter1-6_SP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Inverter7-12_SP_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Inverter7-12_SP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO1.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO1.2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO1.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO1.3_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO1.3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO2.3_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO2.3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO3.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO3.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO4.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO4.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2-PRO 3.1 RND_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2-PRO 3.1 RND_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2MEZZ1.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2MEZZ1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LP.2WH1.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LP.2WH1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LVMDP1_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LVMDP1_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LVMDP1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LVMDP1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LVMDP2_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LVMDP2_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_LVMDP2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_LVMDP2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_MVMDP_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_MVMDP_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_MVMDP_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_MVMDP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Mixagrip_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Mixagrip_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-AC1.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-AC1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-AC1.2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-AC1.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-AC1.3_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-AC1.3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-AC2.3_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-AC2.3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-Boiler&PW_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-Boiler&PW_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-Chiller_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-Chiller_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-Genset_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-Genset_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-HWP_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-HWP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-Kompressor_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-Kompressor_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-Lift_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-Lift_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1-PUMPS_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1-PUMPS_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1AGV_WH1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1AGV_WH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1AGV_WH2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1AGV_WH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.1WWTP_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.1WWTP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-AC 3.1 RND_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-AC 3.1 RND_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-Fasilitas_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-Fasilitas_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-Fatigon_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-Fatigon_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-Hydrant_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-Hydrant_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-LabLt.2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-LabLt.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-Mixagrib_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-Mixagrib_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-PackWH_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-PackWH_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2-Puyer_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2-Puyer_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2DumbWaiter_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2DumbWaiter_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.2Pumpit_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.2Pumpit_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PP.Lab.Lt2_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PP.Lab.Lt2_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.1-UTY_Lt.1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.1-UTY_Lt.2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.1-UTY_Lt.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.2-Koperasi_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.2-Koperasi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.2-PosJaga1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.2-PosJaga1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.2-PosJaga2_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.2-PosJaga2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.2-Workshop_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.2-Workshop_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_PPLP.2OfficeLt1_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_PPLP.2OfficeLt1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_Puyer_Detik_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_Puyer_Detik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_SDP.1-Produksi_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_SDP.1-Produksi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_SDP.1-Utility_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_SDP.1-Utility_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_SDP.2-Produksi_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_SDP.2-Produksi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-Gedung-UTY_SDP_Genset_data\` FROM \`ems_saka\`.\`cMT-Gedung-UTY_SDP_Genset_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;

  `;
    console.log(fatchquerry);
    db3.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyChiller138: async (request, response) => {
    const fetchquery = `
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-BodiChillerCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-BodiChillerCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-BodiChillerCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-BodiChillerCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-BodiChillerCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-BodiChillerCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdorK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdorK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdorK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdorK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdorK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdorK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdrK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdrK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdrK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdrK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-FanOutdrK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-FanOutdrK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GlsExpVlvK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GroundAmperCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GroundAmperCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GroundAmperCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GroundAmperCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-GroundAmperCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-GroundAmperCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-InletSoftCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-InletSoftCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-InletSoftCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-InletSoftCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-InletSoftCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-InletSoftCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-JamMonitorCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-JamMonitorCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-JamMonitorCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-JamMonitorCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-JamMonitorCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-JamMonitorCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-KisiKondenCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-KisiKondenCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-KisiKondenCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-KisiKondenCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-KisiKondenCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-KisiKondenCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaOperCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaOperCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaOperCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaOperCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaOperCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaOperCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaSpvCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaSpvCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaSpvCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaSpvCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaSpvCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaSpvCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaTekCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaTekCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaTekCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaTekCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-NamaTekCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-NamaTekCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OlGlasAtsK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsAtsK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-OliGlsBwhK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PrSesPomRetCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PrSesPomRetCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PrSesPomRetCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PrSesPomRetCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PrSesPomRetCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PrSesPomRetCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPmSupCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPmSupCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPmSupCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPmSupCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPmSupCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPmSupCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPomRtCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPomRtCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPomRtCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPomRtCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSebPomRtCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSebPomRtCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSesPomSpCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSesPomSpCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSesPomSpCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSesPomSpCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-PreSesPomSpCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-PreSesPomSpCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSebPmSupCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-ShuSesPmSupCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-StatFanKondCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-StatFanKondCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-StatFanKondCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-StatFanKondCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-StatFanKondCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-StatFanKondCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSbPomRetCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-SuhSesPmRetCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknReturnCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknReturnCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknReturnCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknReturnCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknReturnCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknReturnCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknSupplyCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknSupplyCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknSupplyCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknSupplyCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_H-TknSupplyCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_H-TknSupplyCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPR1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPR1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPR2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPR2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPR3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPR3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPS1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPS1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPS2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPS2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_O-StatONPS3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_O-StatONPS3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ActiSetpoiCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ActiSetpoiCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ActiSetpoiCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ActiSetpoiCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ActiSetpoiCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ActiSetpoiCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AlarmCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AlarmCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AlarmCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AlarmCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AlarmCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AlarmCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-AmpereK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-AmpereK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CapacityK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CapacityK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-ConSatTemK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-ConSatTemK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondApproK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondApproK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-CondPressK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-CondPressK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischTempK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischTempK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-DischarSHK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-DischarSHK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EXVPositiK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EXVPositiK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvaDsgAppK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapApproK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapApproK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapEWTCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapEWTCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapEWTCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapEWTCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapEWTCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapEWTCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapLWTCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapLWTCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapLWTCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapLWTCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapLWTCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapLWTCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapPressK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapPressK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-EvapSatTeK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-No.StartK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-No.StartK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPresDfK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPresDfK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OilPressK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OilPressK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OutTempCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OutTempCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OutTempCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OutTempCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-OutTempCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-OutTempCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-RunHourK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-RunHourK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-StatusK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-StatusK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctiTempK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctiTempK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK1CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK1CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK1CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK1CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK1CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK1CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK2CH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK2CH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK2CH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK2CH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-SuctionSHK2CH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-SuctionSHK2CH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-UnitCapCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-UnitCapCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-UnitCapCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-UnitCapCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_R-UnitCapCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_R-UnitCapCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpR-SCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpR-SCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpR-SCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpR-SCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpR-SCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpR-SCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpS-TCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpS-TCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpS-TCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpS-TCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpS-TCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpS-TCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpT-RCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpT-RCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpT-RCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpT-RCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-AmpT-RCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-AmpT-RCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegR-SCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegR-SCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegR-SCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegR-SCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegR-SCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegR-SCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegS-TCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegS-TCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegS-TCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegS-TCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegS-TCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegS-TCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegT-RCH1_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegT-RCH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegT-RCH2_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegT-RCH2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-Chiller-UTY3_RP-TegT-RCH3_data\` FROM \`parammachine_saka\`.\`CMT-DB-Chiller-UTY3_RP-TegT-RCH3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1; 
    `;

    //console.log(fetchquery);
    db3.query(fetchquery, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyBoiler138: async (request, response) => {
    const fatchquerry = `
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BahanBakaBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BahanBakaBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BahanBakaBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BahanBakaBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BahanBakaBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BahanBakaBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BodiBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BodiBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BodiBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BodiBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_BodiBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_BodiBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler1Gas_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler1Gas_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler1Solar_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler1Solar_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler2Gas_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler2Gas_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler2Solar_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler2Solar_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler3Gas_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler3Gas_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_Boiler3Solar_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_Boiler3Solar_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_CekBocorBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_CekBocorBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_CekBocorBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_CekBocorBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_CekBocorBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_CekBocorBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ConductivBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ConductivBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ConductivBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ConductivBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ConductivBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ConductivBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_FeedWaterBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_FeedWaterBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_FeedWaterBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_FeedWaterBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_FeedWaterBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_FeedWaterBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasB-EffBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasB-EffBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasB-EffBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasB-EffBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasB-EffBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasB-EffBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasFuelCoBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasFuelCoBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasFuelCoBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasFuelCoBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_GasFuelCoBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_GasFuelCoBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft1Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft1Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft1Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft1Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft1Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft1Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft2Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft2Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft2Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft2Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HardSoft2Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HardSoft2Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HourMeterBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HourMeterBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HourMeterBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HourMeterBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_HourMeterBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_HourMeterBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_IgnicountBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_IgnicountBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_IgnicountBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_IgnicountBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_IgnicountBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_IgnicountBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_JamMonitoBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_JamMonitoBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_JamMonitoBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_JamMonitoBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_JamMonitoBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_JamMonitoBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_LvlChemicBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_LvlChemicBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_LvlChemicBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_LvlChemicBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_LvlChemicBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_LvlChemicBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamUtySpvBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamUtySpvBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamUtySpvBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamUtySpvBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamUtySpvBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamUtySpvBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaOperaBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaOperaBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaOperaBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaOperaBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaOperaBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaOperaBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaOperator4_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaOperator4_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaTekniBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaTekniBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaTekniBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaTekniBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_NamaTekniBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_NamaTekniBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilB-EffBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilB-EffBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilB-EffBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilB-EffBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilB-EffBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilB-EffBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilFuelCoBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilFuelCoBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilFuelCoBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilFuelCoBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilFuelCoBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilFuelCoBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilPressBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilPressBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilPressBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilPressBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_OilPressBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_OilPressBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft1Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft1Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft1Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft1Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft1Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft1Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft2Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft2Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft2Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft2Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_PresSoft2Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_PresSoft2Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft1Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft1Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft1Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft1Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft1Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft1Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft2Boiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft2Boiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft2Boiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft2Boiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_RegeSoft2Boiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_RegeSoft2Boiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StatusBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StatusBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StatusBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StatusBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StatusBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StatusBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamOutBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamOutBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamOutBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamOutBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamOutBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamOutBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamPresBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamPresBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamPresBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamPresBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SteamPresBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SteamPresBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StockChemBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StockChemBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StockChemBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StockChemBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_StockChemBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_StockChemBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SurfaBlowBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SurfaBlowBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SurfaBlowBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SurfaBlowBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_SurfaBlowBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_SurfaBlowBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankCondeBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankCondeBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankCondeBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankCondeBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankCondeBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankCondeBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankSolarBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankSolarBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankSolarBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankSolarBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankSolarBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankSolarBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankiSolarBoiler_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankiSolarBoiler_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankiSolarGenset_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankiSolarGenset_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankiSolarHydrant_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankiSolarHydrant_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankiSolarUtama1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankiSolarUtama1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TankiSolarUtama2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TankiSolarUtama2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeBlowBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeBlowBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeBlowBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeBlowBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeBlowBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeBlowBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeSootBoiler1_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeSootBoiler1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeSootBoiler2_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeSootBoiler2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_ToNeSootBoiler3_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_ToNeSootBoiler3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TotBoilerm3N_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TotBoilerm3N_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TotBoilermmbtu_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TotBoilermmbtu_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TotEffGasBoil_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TotEffGasBoil_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TotEffSolarBoi_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TotEffSolarBoi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-BOILER-UTY_TotOutSteamBoil_data\` FROM parammachine_saka.\`cMT-DB-BOILER-UTY_TotOutSteamBoil_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;

    db4.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyInstrumentIPC: async (request, response) => {
    const fatchquerry = `
    SELECT created_date AS Tanggal_Moisture FROM sakaplant_prod_ipc_ma_staging ORDER BY id_setup DESC LIMIT 1;
    SELECT created_date AS Tanggal_Sartorius FROM sakaplant_prod_ipc_scale_staging ORDER BY id_setup DESC LIMIT 1;
    `;
    db4.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyHVAC55: async (request, response) => {
    const fatchquerry = ` 
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_ F6 AHU 3.01 His_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_ F6 AHU 3.01 His_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_ F6 AHU 3.02 His_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_ F6 AHU 3.02 His_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_ F9 AHU 3.01 His_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_ F9 AHU 3.01 His_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_ F9 AHU 3.02 His_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_ F9 AHU 3.02 His_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP F6 AHU 3.01_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP F6 AHU 3.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP F6 AHU 3.02_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP F6 AHU 3.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP F9 AHU 3.01_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP F9 AHU 3.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP F9 AHU 3.02_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP F9 AHU 3.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP H13 AHU 3.01_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP H13 AHU 3.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_DP H13 AHU 3.02_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_DP H13 AHU 3.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-01_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-02_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-03_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-03_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-04_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-04_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-05_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-05_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-06_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-06_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-07_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-07_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-08_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-08_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-09_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-09_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-10_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-10_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-11_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-11_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-12_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-12_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-13_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-13_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_EMS_LINA_HMI-14_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_EMS_LINA_HMI-14_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_H13 AHU 3.01 Hi_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_H13 AHU 3.01 Hi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-HVAC-LINE-A_H13 AHU 3.02 Hi_data\` FROM \`parammachine_saka\`.\`cMT-HVAC-LINE-A_H13 AHU 3.02 Hi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;
    db3.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyPower55: async (request, response) => {
    const fatchquerry = `
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 E 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 E 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 F 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 F 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 F 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 F 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 FT 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 FT 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 FT 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 FT 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 G 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 G 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 G 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 G 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 LA 2.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 LA 2.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 MG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 MG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 MG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 MG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 WG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 WG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F6 WG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F6 WG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 E 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 E 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 F 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 F 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 F 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 F 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 FT 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 FT 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 FT 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 FT 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 LA 2.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 LA 2.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 MG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 MG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 MG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 MG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 WG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 WG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP F9 WG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP F9 WG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 E 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 E 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 FT 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 FT 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 FT 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 FT 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 MG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 MG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 MG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 MG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 WG 1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 WG 1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_DP H13 WG 1.02_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_DP H13 WG 1.02_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_M_Curren2_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_M_Curren2_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_M_Current_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_M_Current_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_M_Temp_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_M_Temp_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_Totalizer%Chiler_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_Totalizer%Chiler_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_X-Z_AX_RM_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_X-Z_AX_RM_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_XZR_AX_RM_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_XZR_AX_RM_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_X_ACC_G_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_X_ACC_G_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_X_AXISVCF_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_X_AXISVCF_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_X_Axis_Ve_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_X_Axis_Ve_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_Z_ACC_G_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_Z_ACC_G_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_Z_AXISVCF_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_Z_AXISVCF_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_Z_Axis_Ve_FT1.01_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_Z_Axis_Ve_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_Chiller_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_Chiller_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_Fasilitas_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_Fasilitas_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_Hydrant_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_Hydrant_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_LVMDP 1_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_LVMDP 1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_LVMDP 2_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_LVMDP 2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_MVMDP_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_MVMDP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_kWh_SDP2_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_kWh_SDP2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_m3_ inlet pretre_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_m3_ inlet pretre_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_m3_Boiler_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_m3_Boiler_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_m3_Domestik_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_m3_Domestik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_m3_Outdoor_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_m3_Outdoor_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-PowerMeterMezzanine_m3_PDAM_data\` FROM \`parammachine_saka\`.\`cMT-PowerMeterMezzanine_m3_PDAM_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;

    db3.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  // GetDailyINV_HVAC: async (request, response) => {
  //   const fatchquerry = `
  //   SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-INV-HVAC-UTY_1_Current_FT1.01_data\` FROM \`parammachine_saka\`.\`CMT-DB-INV-HVAC-UTY_1_Current_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  //   SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_CMT-DB-INV-HVAC-UTY_2_Current_FT1.01_data\` FROM \`parammachine_saka\`.\`CMT-DB-INV-HVAC-UTY_2_Current_FT1.01_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
  //   `;

  //   db3.query(fatchquerry, (err, result) => {
  //     if (err) {
  //       console.log(err);
  //       return response.status(500).send("Database query failed");
  //     }
  //     return response.status(200).send(result);
  //   });
  // },

  GetDailyWATER: async (request, response) => {
    const fatchquerry = `
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_AirMancur_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Atas QC_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_AtsToilet_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Boiler_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Boiler_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_CIP_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_CIP_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Chiller_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Chiller_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Dom_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Dom_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_FT270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_FT270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Hotwater_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Inlet_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Inlet_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Lab_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Lab_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Lantai1_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Lantai1_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Loopo_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Loopo_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Air Mancur_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Air Mancur_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Atas Lab QC_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Atas Lab QC_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Atas Toilet2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Atas Toilet2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Boiler_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Boiler_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_CIP_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_CIP_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Chiller_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Chiller_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Domestik_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Domestik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Hotwater_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Hotwater_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Inlet_Pt_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Inlet_Pt_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Lab_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Lab_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Lantai1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Lantai1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Loopo_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Loopo_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Osmotron_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Osmotron_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Outlet_Pt_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Outlet_Pt_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_PDAM_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_PDAM_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Produksi_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Produksi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_RO_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_RO_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Softwater_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Softwater_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Taman_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Taman_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Washing_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Washing_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Met_Workshop_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Met_Workshop_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Osmotron_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Osmotron_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Outlet_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Outlet_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_PDAM_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_PDAM_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Produksi_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Produksi_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_QE845A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_QE845A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_QE845A_8.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_QE845A_8.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_RO_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_RO_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Softwater_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Softwater_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_TE845A_8.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_TE845A_8.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Taman_sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Taman_sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Biologi_1d_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Biologi_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Biologi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Kimia_1d_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Kimia_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Kimia_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Outlet_1d_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_WWTP_Outlet_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_WWTP_Outlet_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Washing_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Washing_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_Workshop_Sehari_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_Workshop_Sehari_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_airmancur_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_airmancur_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_boiler_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_boiler_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_chiller_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_chiller_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_cip_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_cip_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_domestik_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_domestik_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_hotwater_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_hotwater_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_inletpr_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_inletpr_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_lab_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_lab_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_labqc_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_labqc_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_lantai1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_lantai1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_loopo_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_loopo_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_osmotron_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_osmotron_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_outletpr_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_outletpr_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_pdam_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_pdam_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_produksi_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_produksi_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_ro_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_ro_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_softwater_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_softwater_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_taman_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_taman_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_toiletlt2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_toiletlt2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_washing_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_washing_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_workshop_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_workshop_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_wwtpbio_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_wwtpbio_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_wwtpkimia_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_wwtpkimia_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_alarm_wwtpoutlet_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_alarm_wwtpoutlet_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_A845A_2.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_A845A_2.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_FT845A_8.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_FT845A_8.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_LT560A_1.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_LT560A_1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_P845A_1.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_P845A_1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_PT845A_1.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_PT845A_1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_PT845A_8.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_PT845A_8.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_QE845A_4.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_QE845A_4.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_QE845A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_QE845A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_RunHour_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_RunHour_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_TT845A_3.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_TT845A_3.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_lopo_V845A_3.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_lopo_V845A_3.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_B270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_B270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_ET270A_6.11_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_ET270A_6.11_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_ET270A_6.12_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_ET270A_6.12_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FIT270A_5.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FIT270A_5.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FIT270_5.50_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FIT270_5.50_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FT270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FT270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FT270A_5.51_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FT270A_5.51_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FT270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FT270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_FT270A_6.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_FT270A_6.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_11.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_11.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_12.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_12.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_13.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_13.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_1.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_5.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_5.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_P270A_7.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_P270A_7.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PDY270A_5.4_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PDY270A_5.4_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PDY270A_5.7_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PDY270A_5.7_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_1.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_1.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.4_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.4_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.5_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.5_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.6_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.6_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.7_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.7_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_5.8_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_5.8_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_6.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_6.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_PT270A_6.3_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_PT270A_6.3_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_QE270A_11.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_QE270A_11.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_QE270A_12.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_QE270A_12.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_QE270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_QE270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_QE270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_QE270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_QE270A_6.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_QE270A_6.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_TE270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_TE270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_TE270A_6.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_TE270A_6.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_TT270A_5.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_TT270A_5.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_V270A_5.10_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_V270A_5.10_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_V270A_5.50_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_V270A_5.50_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_V270A_5.51_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_V270A_5.51_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_V270A_6.2_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_V270A_6.2_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_V270A_6.5_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_V270A_6.5_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_W270A_5.1_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_W270A_5.1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
      SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-WATER-UTY2_osmo_WCF_Factor_data\` FROM \`parammachine_saka\`.\`cMT-DB-WATER-UTY2_osmo_WCF_Factor_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;

    db3.query(fatchquerry, (err, result) => {   
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyDehum: async (request, response) => {
    const fatchquerry = `
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DehumRNDLt3danWH1_PrekursorWH1_data\` FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_PrekursorWH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DehumRNDLt3danWH1_RakLayer3-C56WH1_data\` FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_RakLayer3-C56WH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DehumRNDLt3danWH1_RakLayer3-C64WH1_data\` FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_RakLayer3-C64WH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DehumRNDLt3danWH1_RakLayer3-C72WH1_data\` FROM parammachine_saka.\`cMT-DehumRNDLt3danWH1_RakLayer3-C72WH1_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;

    db3.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GetDailyEMSUTY: async (request, response) => {
    const fatchquerry = `
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_Area_N33_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_Area_N33_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_Area_P10_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_Area_P10_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_Area_W25toN33_Nw_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_Area_W25toN33_Nw_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_Area_W25toP10_Nw_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_Area_W25toP10_Nw_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_GAC_WH2_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_GAC_WH2_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_GBAC1_WH1_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_GBAC1_WH1_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_GBAC2_WH1_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_GBAC2_WH1_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_PackagingF_Ln1_N_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_PackagingF_Ln1_N_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_PackagingF_Ln2_N_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_PackagingF_Ln2_N_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_PackagingF_Ln3_N_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_PackagingF_Ln3_N_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K27_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K27_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K30_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K30_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K31_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K31_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K32_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K32_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K33_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K33_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K34_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K34_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K35_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K35_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.K36_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.K36_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.N03_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.N03_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.N04_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.N04_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.N05_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.N05_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.N06_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.N06_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.Tools1_WG_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.Tools1_WG_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W03_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W03_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W04_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W04_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W05_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W05_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W06-1_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W06-1_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W06-2_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W06-2_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W09_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W09_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W17(Spare)_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W17(Spare)_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W18_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W18_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W19_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W19_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W20_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W20_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W21_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W21_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W22_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W22_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W23_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W23_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W24_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W24_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R.W25_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R.W25_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N07_Coridor_Nw_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N07_Coridor_Nw_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N07_Machine_Nw_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N07_Machine_Nw_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N08_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N08_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N10_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N10_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N11_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N11_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N13_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N13_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N14_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N14_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N15_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N15_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N16_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N16_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N18_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N18_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N20_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N20_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_N28_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_N28_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P01_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P01_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P02_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P02_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P03_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P03_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P05_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P05_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P06_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P06_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P11_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P11_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P12_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P12_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P13_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P13_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_P14_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_P14_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X01_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X01_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X02_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X02_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X03_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X03_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X04_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X04_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X05_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X05_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X06_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X06_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X09_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X09_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X10_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X10_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    SELECT DATE(FROM_UNIXTIME(\`time@timestamp\`)) AS \`Tanggal_cMT-DB-EMS-UTY2_R_X11_New_data\` FROM ems_saka.\`cMT-DB-EMS-UTY2_R_X11_New_data\` ORDER BY \`time@timestamp\` DESC LIMIT 1;
    `;

    db4.query(fatchquerry, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GrafanaWater: async (request, response) => {
    const { area } = request.query;
    const queryGet = `
    SELECT 
    x,
    y
    FROM (
        SELECT 
            \`time@timestamp\` AS x,
            CASE 
                WHEN @prev_value IS NULL THEN 0
                ELSE data_format_0 - @prev_value
            END AS y,
            @prev_value := data_format_0
        FROM 
            (
                SELECT \`time@timestamp\`, data_format_0
                FROM \`parammachine_saka\`.\`${area}\`
                WHERE \`time@timestamp\` >= UNIX_TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-01')) -- Tanggal 1 bulan ini
                  AND \`time@timestamp\` < UNIX_TIMESTAMP(DATE(NOW())) -- Hingga kemarin
            ) AS combined_data
        ORDER BY 
            \`time@timestamp\`
    ) AS inner_query;
    `;
    db3.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GrafanaPower: async (request, response) => {
    const { area } = request.query;
    const queryGet = `
    SELECT 
    x,
    y
    FROM (
        SELECT 
            \`time@timestamp\` AS x,
            CASE 
                WHEN @prev_value IS NULL THEN 0
                ELSE data_format_0 - @prev_value
            END AS y,
            @prev_value := data_format_0
        FROM 
            (
                SELECT \`time@timestamp\`, data_format_0
                FROM \`ems_saka\`.\`${area}\`
                WHERE \`time@timestamp\` >= UNIX_TIMESTAMP(DATE_FORMAT(NOW(), '%Y-%m-01')) -- Tanggal 1 bulan ini
                  AND \`time@timestamp\` < UNIX_TIMESTAMP(DATE(NOW())) -- Hingga kemarin
            ) AS combined_data
        ORDER BY 
            \`time@timestamp\`
    ) AS inner_query;
    `;
    db4.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GrafanaMVMDPyear: async (request, response) => {
    const { area } = request.query;
    const queryGet = `
    SELECT 
        YEAR(d1.date) AS year,
        MONTH(d1.date) AS month,
        DATE(FROM_UNIXTIME(UNIX_TIMESTAMP(d1.date))) AS time,
        SUM(ABS(d1.daily_diff)) AS monthly_total
    FROM (
        SELECT 
            DATE(FROM_UNIXTIME(t1.\`time@timestamp\`)) AS date,
            t1.data_format_0 - COALESCE(t2.data_format_0, 0) AS daily_diff
        FROM (
            SELECT \`time@timestamp\`, data_format_0
            FROM \`ems_saka\`.\`${area}\`
        ) t1
        LEFT JOIN (
            SELECT \`time@timestamp\`, data_format_0
            FROM \`ems_saka\`.\`${area}\`
        ) t2
        ON DATE(FROM_UNIXTIME(t1.\`time@timestamp\`)) = DATE_SUB(DATE(FROM_UNIXTIME(t2.\`time@timestamp\`)), INTERVAL 1 DAY)
    ) d1
    WHERE d1.daily_diff IS NOT NULL
    GROUP BY year, month
    ORDER BY year, month;
    `;

    db4.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  GrafanaPDAMyear: async (request, response) => {
    const { area } = request.query;
    const queryGet = `
    SELECT 
        YEAR(d1.date) AS year,
        MONTH(d1.date) AS month,
        DATE(FROM_UNIXTIME(UNIX_TIMESTAMP(d1.date))) AS time,
        SUM(ABS(d1.daily_diff)) AS monthly_total
    FROM (
        SELECT 
            DATE(FROM_UNIXTIME(t1.\`time@timestamp\`)) AS date,
            t1.data_format_0 - COALESCE(t2.data_format_0, 0) AS daily_diff
        FROM (
            SELECT \`time@timestamp\`, data_format_0
            FROM \`parammachine_saka\`.\`${area}\`
        ) t1
        LEFT JOIN (
            SELECT \`time@timestamp\`, data_format_0
            FROM \`parammachine_saka\`.\`${area}\`
        ) t2
        ON DATE(FROM_UNIXTIME(t1.\`time@timestamp\`)) = DATE_SUB(DATE(FROM_UNIXTIME(t2.\`time@timestamp\`)), INTERVAL 1 DAY)
    ) d1
    WHERE d1.daily_diff IS NOT NULL
    GROUP BY year, month
    ORDER BY year, month;
    `;

    db3.query(queryGet, (err, result) => {
      if (err) {
        console.log(err);
        return response.status(500).send("Database query failed");
      }
      return response.status(200).send(result);
    });
  },

  
  //-------------------------Mesin Report--------------------------

  HM1Report: async (request, response) => {
    const { tanggal, shift, area } = request.query;

    if (!tanggal || !shift) {
      return response
        .status(400)
        .send({ error: "Tanggal dan shift harus diisi" });
    }

    const checkExistQuery = `
      SELECT 1 FROM Downtime_Mesin
      WHERE DATE(start) = ? AND shift = ?
      LIMIT 1
    `;

    db3.query(checkExistQuery, [tanggal, shift], (err, existResult) => {
      if (err) {
        console.error("Database check error:", err);
        return response.status(500).send({ error: "Database check error" });
      }

      const sendFilteredResponse = () => {
        const selectQuery = `
          SELECT 
            id,
            DATE_FORMAT(start, '%H:%i') AS start,
            DATE_FORMAT(finish, '%H:%i') AS finish,
            total_menit
          FROM Downtime_Mesin
          WHERE DATE(start) = ? AND shift = ? AND downtime_type IS NULL AND mesin = ?
        `;

        //console.log(selectQuery);
        db3.query(selectQuery, [tanggal, shift, area], (err, rows) => {
          console.log('Backend Raw Query Results:', rows); 
          if (err) {
            console.error("Select error:", err);
            return response.status(500).send({ error: "Select error" });
          }
          return response.status(200).send(rows);
        });
      };
      

      if (existResult.length > 0) {
        return sendFilteredResponse();
      }

      let queryGet = "";
      if (shift === "1") {
        queryGet = `
          SELECT
            FROM_UNIXTIME(\`time@timestamp\`) AS waktu,
            \`time@timestamp\` AS raw_timestamp,
            data_format_0 AS y
          FROM \`parammachine_saka\`.\`mezanine.tengah_runn_${area}_data\`
          WHERE
            DATE_SUB(FROM_UNIXTIME(\`time@timestamp\`), INTERVAL 7 HOUR) BETWEEN '${tanggal} 06:30:00' AND '${tanggal} 15:00:00'
            AND data_format_0 = 0
          ORDER BY \`time@timestamp\`
        `;
      } else if (shift === "2") {
        queryGet = `
          SELECT
            FROM_UNIXTIME(\`time@timestamp\`) AS waktu,
            \`time@timestamp\` AS raw_timestamp,
            data_format_0 AS y
          FROM \`parammachine_saka\`.\`mezanine.tengah_runn_${area}_data\`
          WHERE
            DATE_SUB(FROM_UNIXTIME(\`time@timestamp\`), INTERVAL 7 HOUR) BETWEEN '${tanggal} 15:00:00' AND '${tanggal} 23:00:00'
            AND data_format_0 = 0
          ORDER BY \`time@timestamp\`
        `;
      } else if (shift === "3") {
        queryGet = `
          SELECT
            FROM_UNIXTIME(\`time@timestamp\`) AS waktu,
            \`time@timestamp\` AS raw_timestamp,
            data_format_0 AS y
          FROM \`parammachine_saka\`.\`mezanine.tengah_runn_${area}_data\`
          WHERE (
            DATE_SUB(FROM_UNIXTIME(\`time@timestamp\`), INTERVAL 7 HOUR) BETWEEN '${tanggal} 23:00:00' AND '${tanggal} 00:00:00'
            OR
            DATE_SUB(FROM_UNIXTIME(\`time@timestamp\`), INTERVAL 7 HOUR) BETWEEN '${tanggal} 00:00:00' AND '${tanggal} 06:30:00'
          )
          AND data_format_0 = 0
          ORDER BY \`time@timestamp\`
        `;
      } else {
        return response.status(400).send({ error: "Shift tidak valid" });
      }

      console.log(queryGet);
      db3.query(queryGet, (err, result) => {
        if (err) {
          console.error("Database query error:", err);
          return response.status(500).send({ error: "Database query error" });
        }

        const grouped = [];
        let currentGroup = null;
        let prevTime = null;

        for (let row of result) {
          const currentTime = new Date(row.waktu);

          if (!currentGroup || (prevTime && currentTime - prevTime > 60000)) {
            if (currentGroup) {
              grouped.push({
                start: currentGroup.start,
                finish: currentGroup.finish,
                total_minutes: Math.round(
                  (currentGroup.finish - currentGroup.start) / 60000
                ),
              });
            }
            currentGroup = {
              start: currentTime,
              finish: currentTime,
            };
          } else {
            currentGroup.finish = currentTime;
          }

          prevTime = currentTime;
        }

        if (currentGroup) {
          grouped.push({
            start: currentGroup.start,
            finish: currentGroup.finish,
            total_minutes: Math.round(
              (currentGroup.finish - currentGroup.start) / 60000
            ),
          });
        }

        const filtered = grouped.filter((item) => item.total_minutes >= 3);

        if (filtered.length === 0) {
          return response.status(200).send([]);
        }

        const checkExistingQuery = `
          SELECT shift, start, finish
          FROM Downtime_Mesin
          WHERE DATE(start) = ? AND shift = ?
        `;

        db3.query(checkExistingQuery, [tanggal, shift], (err, existingRows) => {
          if (err) {
            console.error("Check existing entries error:", err);
            return response
              .status(500)
              .send({ error: "Check existing entries error" });
          }

          const existingSet = new Set(
            existingRows.map(
              (row) =>
                `${
                  row.shift
                }|${row.start.toISOString()}|${row.finish.toISOString()}`
            )
          );

          const newEntries = filtered.filter((item) => {
            const key = `${shift}|${item.start.toISOString()}|${item.finish.toISOString()}`;
            return !existingSet.has(key);
          });

          if (newEntries.length === 0) {
            return sendFilteredResponse();
          }

          const insertValues = newEntries.map((item) => [
            parseInt(shift),
            new Date(item.start.getTime() - 7 * 60 * 60 * 1000),
            new Date(item.finish.getTime() - 7 * 60 * 60 * 1000),
            item.total_minutes,
            area,
          ]);

          const insertQuery = `
            INSERT INTO Downtime_Mesin (shift, start, finish, total_menit, mesin)
            VALUES ?
          `;

          db3.query(insertQuery, [insertValues], (insertErr) => {
            if (insertErr) {
              console.error("Insert error:", insertErr);
              return response.status(500).send({ error: "Insert error" });
            }

            return sendFilteredResponse();
          });
        });
      });
    });
  },

  alldowntime: async (request, response) => {
    const { type } = request.query;

    // Cek apakah parameter type ada
    if (!type) {
      return response
        .status(400)
        .send({ error: "Parameter 'type' diperlukan" });
    }

    // Query hanya kolom keterangan_downtime dengan filter downtime_type
    const queryData = `SELECT detail FROM parammachine_saka.alldowntime_db WHERE downtime_type = '${type}'`;

    console.log(queryData);
    db3.query(queryData, (err, result) => {
      if (err) {
        return response
          .status(500)
          .send({ error: "Database error", detail: err });
      }

      return response.status(200).send(result);
    });
  },

  HM1InsertDowntime: async (req, res) => {
    const {
      id,
      downtime_type,
      downtime_detail,
      username,
      submitted_at,
      keterangan,
    } = req.body;

    // Validasi field
    if (
      !id ||
      !downtime_type ||
      !downtime_detail ||
      !username ||
      !submitted_at ||
      !keterangan
    ) {
      return res.status(400).send({ error: "Semua field harus diisi" });
    }

    try {
      const checkQuery = `
        SELECT * FROM Downtime_Mesin
        WHERE id = ?
          AND downtime_type IS NULL
          AND detail IS NULL
          AND user IS NULL
          AND submit_date IS NULL
          AND keterangan IS NULL
        LIMIT 1
      `;

      db3.query(checkQuery, [id], (err, results) => {
        if (err) {
          console.error("Check error:", err);
          return res.status(500).send({ error: "Gagal cek data di database" });
        }

        if (results.length === 0) {
          return res
            .status(400)
            .send({ error: "Data tidak ditemukan atau sudah terisi" });
        }

        // Update data jika valid
        const updateQuery = `
          UPDATE Downtime_Mesin
          SET downtime_type = ?, detail = ?, user = ?, submit_date = ?, keterangan = ?
          WHERE id = ?
            AND downtime_type IS NULL
            AND detail IS NULL
            AND user IS NULL
            AND submit_date IS NULL
            AND keterangan IS NULL
        `;

        db3.query(
          updateQuery,
          [
            downtime_type,
            downtime_detail,
            username,
            submitted_at,
            keterangan,
            id,
          ],
          (err, result) => {
            if (err) {
              console.error("Update error:", err);
              return res
                .status(500)
                .send({ error: "Gagal update data di database" });
            }
            return res
              .status(200)
              .send({ success: true, message: "Data berhasil diupdate" });
          }
        );
      });
    } catch (err) {
      console.error("Server error:", err);
      res.status(500).send({ error: "Terjadi kesalahan pada server" });
    }
  },

  HM1InsertDowntimeWithSubRows: async (req, res) => {
    const { mainRow, subRows } = req.body;
    const parsedId = parseInt(mainRow?.id);

    console.log("Parsed ID:", parsedId);
    console.log("SubRows:", subRows);

    if (!Array.isArray(subRows) || subRows.length === 0) {
      return res
        .status(400)
        .send({ error: "Data subRows kosong atau tidak valid" });
    }

    if (!parsedId || isNaN(parsedId)) {
      return res.status(400).send({ error: "ID tidak valid" });
    }

    const deleteQuery = `DELETE FROM Downtime_Mesin WHERE id = ?`;
    const insertQuery = `
    INSERT INTO Downtime_Mesin
    (shift, start, finish, total_menit, mesin, downtime_type, detail, user, submit_date, keterangan)
    VALUES ?
  `;

    try {
      db3.query(deleteQuery, [parsedId], (deleteErr, deleteResult) => {
        if (deleteErr) {
          console.error("Delete error:", deleteErr);
          return res.status(500).send({ error: "Gagal hapus data lama" });
        }

        console.log("Rows deleted:", deleteResult.affectedRows);

        const values = subRows.map((item) => {
          const fullStart = `${item.tanggal} ${item.start}`;
          const fullFinish = `${item.tanggal} ${item.finish}`;

          return [
            item.shift,
            fullStart,
            fullFinish,
            item.total_menit,
            item.mesin || item.area,
            item.downtime_type,
            item.detail || item.downtime_detail,
            item.user || item.username,
            item.submit_date || item.submitted_at,
            item.keterangan || "",
          ];
        });

        db3.query(insertQuery, [values], (insertErr, insertResult) => {
          if (insertErr) {
            console.error("Insert error:", insertErr);
            return res.status(500).send({ error: "Gagal insert data baru" });
          }

          return res.status(200).send({
            success: true,
            message: "Data berhasil diganti dengan sub-row baru",
          });
        });
      });
    } catch (error) {
      console.error("Server error:", error);
      return res.status(500).send({ error: "Terjadi kesalahan di server" });
    }
  },


  // New function to fetch ONLY planned downtime records


// You would then register this in your router:
// router.get('/GetPlannedDowntime', GetPlannedDowntime);

  //-------------------------Data Login--------------------------

  GetPlannedDowntime: async (request, response) => {
    const { tanggal, shift, area } = request.query;

    if (!tanggal || !shift || !area) {
        return response
            .status(400)
            .send({ error: "Tanggal, shift, dan area harus diisi." });
    }

    // FIX: Normalize the shift parameter to match the database value ('1', '2', or '3').
    const normalizedShift = shift.toString().replace(/\D/g, '').trim(); 
    if (!normalizedShift) {
        return response.status(400).send({ error: "Shift tidak valid." });
    }

    // The Direct SQL Query
    const plannedQuery = `
        SELECT 
            id,
            DATE_FORMAT(start, '%H:%i') AS start,
            DATE_FORMAT(finish, '%H:%i') AS finish,
            total_menit,
            downtime_type,
            detail,
            keterangan
        FROM 
            Downtime_Mesin
        WHERE 
            DATE(start) = ? 
            AND TRIM(shift) = ? 
            AND TRIM(mesin) = ?
            AND downtime_type = 'Planned'  -- **<< Filters only 'Planned' records**
        ORDER BY start
    `;

    const queryParams = [tanggal, normalizedShift, area];

    db3.query(plannedQuery, queryParams, (err, rows) => {
        if (err) {
            console.error("Planned Downtime Select error:", err);
            return response.status(500).send({ error: "Database error fetching planned data." });
        }
        
        return response.status(200).send(rows);
    });
},
/*
  LoginData: async (req, res) => {
    const { name, id, isAdmin, level, imagePath, loginAt, email } = req.body;

    // Validasi field (cek null atau undefined, bukan hanya falsy)
    if (
      name == null ||
      id == null ||
      isAdmin == null ||
      level == null ||
      imagePath == null
    ) {
      return res.status(400).send({ error: "Semua field harus diisi" });
    }

    let clientIp = (
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.socket.remoteAddress ||
      ""
    ).replace(/^::ffff:/, "");
    const insertQuery = `
      INSERT INTO Log_Data_Login (name, id_char, isAdmin, level, imagePath, ip_address, Date, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const insertValues = [
      name,
      id,
      isAdmin,
      level,
      imagePath,
      clientIp,
      loginAt,
      email,
    ];

    db3.query(insertQuery, insertValues, (insertErr) => {
      if (insertErr) {
        console.error("Insert error:", insertErr);
        return res.status(500).send({ error: "Gagal menyimpan data login" });
      }

      return res.status(200).send({ message: "Data login berhasil disimpan" });
    });
  }, */

  LogData: async (req, res) => {
    const queryData = `SELECT * FROM parammachine_saka.Log_Data_Login ORDER BY STR_TO_DATE(Date, '%m/%d/%Y, %r') DESC`;
    console.log(queryData);

    db3.query(queryData, (err, result) => {
      if (err) {
        return res.status(500).send({ error: "Database error", detail: err });
      }
      return res.status(200).send(result);
    });
  },
 
  /*
  LogoutData: async (req, res) => {
    const { id_char, logout_time } = req.body;

    if (!id_char || !logout_time) {
      return res
        .status(400)
        .send({ error: "id_char dan logout_time harus diisi" });
    }

    // Update baris terakhir yang masih aktif
    const updateQuery = `
      UPDATE parammachine_saka.Log_Data_Login
      SET logout_time = ?, status = 'completed'
      WHERE id_char = ? AND (status IS NULL OR status = 'active')
      ORDER BY ID DESC LIMIT 1
    `;

    db3.query(updateQuery, [logout_time, id_char], (err, result) => {
      if (err) {
        return res.status(500).send({ error: "Database error", detail: err });
      }
      return res.status(200).send({ message: "Logout time berhasil diupdate" });
    });
  }, 
  
  */

// Function to fetch downtime records based on user filters
// Function to fetch downtime records based on user filters
downtimeAnalysis: async (request, response) => {
    const { tanggal, shift, area } = request.query; 

    // Validate essential fields
    if (!tanggal || !shift || !area) {
        return response.status(400).send({ error: "Tanggal, shift, dan area (machine) harus diisi" });
    }

    // 🔴 FIX: Use '?' placeholders for secure, parameterized query
    const queryGetChartData = `
        SELECT 
            id,
            total_menit, 
            downtime_type,
            detail,
            keterangan
        FROM 
            Downtime_Mesin
        WHERE 
            DATE(start) = ? 
            AND shift = ? 
            AND mesin = ?
            AND downtime_type IS NOT NULL 
            AND detail IS NOT NULL
        ORDER BY
            start ASC;
    `;
    
    // Create an array of values corresponding to the placeholders (?)
    const queryValues = [tanggal, shift, area];

    try {
        // 🔴 FIX: Convert to promise for cleaner error handling 
        const result = await new Promise((resolve, reject) => {
            // Pass the query string and the array of values
            db3.query(queryGetChartData, queryValues, (err, data) => {
                if (err) return reject(err);
                resolve(data);
            });
        });
        
        // Success: Return the results
        return response.status(200).send(result);
        
    } catch (error) {
        // This catch now handles both the promise rejection and any other runtime errors
        console.error("Server error in downtimeAnalysis:", error);
        return response.status(500).send({ error: "Terjadi kesalahan pada server saat fetching analysis data" });
    }
}, // <-- Ensure this is correctly part of module.exports
bulkImportPMPData: async (request, response) => {
    try {
      const { jobs, category } = request.body;

      // Validate input
      if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
        return response.status(400).send({ error: "Missing job data array." });
      }
      if (!category) {
        return response.status(400).send({ error: "Missing category." });
      }

      console.log(`📥 Received ${jobs.length} jobs to import with category: ${category}`);

      // Map jobs to database columns
      const valuesToInsert = jobs.map(job => [
        job.wo_number,
        job.machine_name,
        job.asset_number,
        category, // category column
        'Pending', // status column
        new Date() // created_at
      ]);

      // Build INSERT query
      const sql = `
        INSERT INTO pmp_pending_jobs 
        (wo_number, machine_name, asset_number, category, status, created_at) 
        VALUES ?
      `;

      db4.query(sql, [valuesToInsert], (err, result) => {
        if (err) {
          console.error('❌ Database Insertion Error:', err.message);
          return response.status(500).send({ 
            error: "Database insertion failed", 
            details: err.message 
          });
        }
        console.log(`✨ Successfully imported ${result.affectedRows} pending jobs.`);
        return response.status(201).send({ 
          message: "Import successful", 
          createdCount: result.affectedRows 
        });
      });

    } catch (error) {
      console.error('❌ Import Error:', error.message);
      return response.status(500).send({ 
        error: "Import processing failed", 
        details: error.message 
      });
    }
  },

createPMPData: async (request, response) => {
        const { machine_name, asset_number, wo_no, operations, month } = request.body;
        
        const sql = "INSERT INTO extracted_maintenance_data (machine_name, asset_number, wo_no, operations, month) VALUES (?, ?, ?, ?, ?)";
        
        db4.query(sql, [machine_name, asset_number, wo_no, operations, month], (err, result) => {
            if (err) {
                console.error('❌ Database CREATE Error:', err.message);
                return response.status(500).send({ error: "Database insertion failed", details: err.message });
            }
            console.log(`✨ Record created with ID: ${result.insertId}`);
            return response.status(201).send({ message: "Record created", insertedId: result.insertId });
        });
    },

    /**
     * READ: Get all PMP records
     * Called by: GET /part/pmp-data
     */
    readPMPData: async (request, response) => {
        const sql = "SELECT * FROM extracted_maintenance_data ORDER BY record_id DESC";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error:', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    /**
     * UPDATE: Update an existing PMP record
     * Called by: PUT /part/pmp-data/:id
     */
    updatePMPData: async (request, response) => {
        const { id } = request.params;
        const { machine_name, asset_number, wo_no, operations, month } = request.body;
        
        const sql = "UPDATE extracted_maintenance_data SET machine_name = ?, asset_number = ?, wo_no = ?, operations = ?, month = ? WHERE record_id = ?";
        
        db4.query(sql, [machine_name, asset_number, wo_no, operations, month, id], (err, result) => {
            if (err) {
                console.error('❌ Database UPDATE Error:', err.message);
                return response.status(500).send({ error: "Database update failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Record not found, no update performed." });
            }
            console.log(`✨ Record ${id} updated.`);
            return response.status(200).send({ message: "Record updated" });
        });
    },

    /**
     * DELETE: Delete a PMP record
     * Called by: DELETE /part/pmp-data/:id
     */
    deletePMPData: async (request, response) => {
        const { id } = request.params;
        const sql = "DELETE FROM extracted_maintenance_data WHERE record_id = ?";
        
        db4.query(sql, [id], (err, result) => {
            if (err) {
                console.error('❌ Database DELETE Error:', err.message);
                return response.status(500).send({ error: "Database delete failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Record not found, no deletion performed." });
            }
            console.log(`✨ Record ${id} deleted.`);
            return response.status(200).send({ message: "Record deleted" });
        });
    },

    getMachinesList: async (request, response) => {
        const sql = "SELECT machine_id, machine_name, asset_number FROM pmp_machines";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },


    // Master Data PMP Machines CRUD Operations //
    getMachinesList: async (request, response) => {
        const sql = "SELECT machine_id, machine_name, asset_number FROM pmp_machines ORDER BY machine_name";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    /**
     * READ: Get all default operations for a *specific machine*
     * Called by: GET /part/default-operations/:machine_id
     */
    getDefaultOperations: async (request, response) => {
        const { machine_id } = request.params;
        const sql = "SELECT * FROM pmp_default_operations WHERE machine_id = ? ORDER BY default_op_id";
        
        db4.query(sql, [machine_id], (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (default_ops):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    /**
     * CREATE: Add a new default operation
     * Called by: POST /part/default-operations
     */
   createDefaultOperation: async (request, response) => {
        // Now expecting an array of descriptions
        const { machine_id, descriptions } = request.body; 

        if (!machine_id || !descriptions || !Array.isArray(descriptions) || descriptions.length === 0) {
            return response.status(400).send({ error: "Invalid input: machine_id and a non-empty descriptions array are required." });
        }

        // --- Build a Bulk Insert Query ---
        // 1. Create the placeholders: (?, ?), (?, ?), (?, ?)
        const placeholders = descriptions.map(() => "(?, ?)").join(', ');
        
        // 2. Create the data array: [1, 'Desc1', 1, 'Desc2', 1, 'Desc3']
        const values = [];
        descriptions.forEach(desc => {
            values.push(machine_id, desc);
        });

        const sql = `INSERT INTO pmp_default_operations (machine_id, description) VALUES ${placeholders}`;
        
        db4.query(sql, values, (err, result) => {
            if (err) {
                console.error('❌ Database BATCH CREATE Error (default_ops):', err.message);
                return response.status(500).send({ error: "Database insertion failed", details: err.message });
            }
            console.log(`✨ ${result.affectedRows} default operations created.`);
            return response.status(201).send({ message: "Operations created", insertedRows: result.affectedRows });
        });
    },

    /**
     * DELETE: Delete a default operation
     * Called by: DELETE /part/default-operations/:op_id
     */
    deleteDefaultOperation: async (request, response) => {
        const { op_id } = request.params;
        const sql = "DELETE FROM pmp_default_operations WHERE default_op_id = ?";
        
        db4.query(sql, [op_id], (err, result) => {
            if (err) {
                console.error('❌ Database DELETE Error (default_ops):', err.message);
                return response.status(500).send({ error: "Database delete failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Operation not found" });
            }
            console.log(`✨ Default operation ${op_id} deleted.`);
            return response.status(200).send({ message: "Operation deleted" });
        });
    },

    getAllOperationsList: async (request, response) => {
        // 'DISTINCT' ensures we only get one copy of each description
        const sql = "SELECT DISTINCT description FROM pmp_default_operations ORDER BY description";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (all_ops):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            // Send back a simple array of strings: ["Check oil", "Clean filter", ...]
            const descriptions = result.map(op => op.description);
            return response.status(200).send(descriptions);
        });
    },

    bulkImportPMPData: async (request, response) => {
    console.log('Starting bulk import from JSON...');
    
    // 1. Get the array of jobs from the request body
    const jobs = request.body; 

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return response.status(400).send({ error: "Missing job data array." });
    }

    let createdCount = 0;
    const errors = [];
    const db4Promise = db4.promise();

    try {
      // 2. Get ALL machines and default ops into maps
      const [machines] = await db4Promise.query('SELECT machine_id, asset_number FROM pmp_machines');
      const [defaultOps] = await db4Promise.query('SELECT machine_id, description FROM pmp_default_operations');

      const machineMap = new Map(); // Map<asset_number, machine_id>
      machines.forEach(m => machineMap.set(m.asset_number, m.machine_id));

      const opsMap = new Map(); // Map<machine_id, string[]>
      defaultOps.forEach(op => {
        if (!opsMap.has(op.machine_id)) {
          opsMap.set(op.machine_id, []);
        }
        opsMap.get(op.machine_id).push(op.description);
      });
      
      console.log(`Loaded ${machineMap.size} machines and ${opsMap.size} operation templates.`);

      // 3. Process each job from the JSON array
      for (const job of jobs) {
        const { asset_number, wo_number, scheduled_date } = job;

        if (!asset_number || !wo_number || !scheduled_date) {
          errors.push(`Skipping row, incomplete data: ${JSON.stringify(job)}`);
          continue; 
        }

        const machineId = machineMap.get(asset_number);
        if (!machineId) {
          errors.push(`Machine not found for asset number: ${asset_number}`);
          continue;
        }

        // --- This is the core logic ---
        try {
          // A) Create the Work Order
          const [woResult] = await db2Promise.query(
            'INSERT INTO pmp_work_orders (machine_id, wo_number, scheduled_date, status) VALUES (?, ?, ?, ?)',
            [machineId, wo_number, scheduled_date, 'Open']
          );
          const newWorkOrderId = woResult.insertId;

          // B) Find its default operations
          const operationsToCopy = opsMap.get(machineId);

          // C) Copy the operations
          if (operationsToCopy && operationsToCopy.length > 0) {
            const opsPlaceholders = operationsToCopy.map(() => '(?, ?)').join(', ');
            const opsValues = [];
            operationsToCopy.forEach(desc => {
              opsValues.push(newWorkOrderId, desc);
            });
            
            await db4Promise.query(
              `INSERT INTO pmp_work_order_operations (work_order_id, description) VALUES ${opsPlaceholders}`,
              opsValues
            );
          }
          createdCount++;

        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') {
            errors.push(`Skipped: Work Order ${wo_number} already exists.`);
          } else {
            errors.push(`Failed to import WO ${wo_number}: ${err.message}`);
          }
        }
      }

    } catch (err) {
      console.error('Fatal import error:', err);
      return response.status(500).send({ error: `Fatal import error: ${err.message}` });
    }

    // 4. Finished! Send response.
    console.log(`Import finished. ${createdCount} jobs created.`);
    if (errors.length > 0) {
      return response.status(207).send({ 
        message: `Import partially successful. ${createdCount} jobs created.`,
        createdCount: createdCount,
        errors: errors 
      });
    }

    return response.status(201).send({ 
      message: `Import successful. ${createdCount} jobs created.`,
      createdCount: createdCount
    });
  },

  bulkImportPendingJobs: async (request, response) => {
    try {
      console.log('📦 bulkImportPendingJobs - incoming keys:', request.body && Object.keys(request.body));
      if (request.rawBody) {
        console.log('📦 bulkImportPendingJobs - raw body length:', request.rawBody.length);
        try {
          const rawParsed = JSON.parse(request.rawBody);
          console.log('📦 bulkImportPendingJobs - raw JSON keys:', rawParsed && Object.keys(rawParsed));
        } catch (e) {
          console.log('📦 bulkImportPendingJobs - raw body not JSON, first 200 chars:', request.rawBody.slice(0, 200));
        }
      }

      // Robust extraction for different payload shapes
      const payload = request.body;
      let jobsRaw = Array.isArray(payload) ? payload : (payload?.jobs ?? payload?.data ?? payload?.payload?.jobs ?? payload?.payload?.data);
      let category = payload?.category ?? payload?.payload?.category ?? payload?.importCategory;

      // If jobs is a JSON string, attempt to parse
      if (typeof jobsRaw === 'string') {
        try { jobsRaw = JSON.parse(jobsRaw); } catch (e) { /* ignore parse error */ }
      }

      // Validate input presence
      if (!Array.isArray(jobsRaw) || jobsRaw.length === 0) {
        return response.status(400).send({ error: "Missing job data array." });
      }
      if (!category || typeof category !== 'string') {
        // Default category if not provided
        category = 'Maintenance';
      }

      // Normalize keys and drop unusable rows
      const normalizedJobs = jobsRaw
        .map(job => ({
          wo_number: job?.wo_number ?? job?.WO_NUMBER ?? job?.woNumber ?? job?.WO ?? job?.pwo ?? job?.PWO,
          machine_name: job?.machine_name ?? job?.machine ?? job?.machineName ?? job?.MACHINE_NAME,
          asset_number: job?.asset_number ?? job?.asset ?? job?.assetNumber ?? job?.ASSET_NUMBER,
        }))
        .filter(job => job.wo_number && (job.asset_number || job.machine_name));

      if (normalizedJobs.length === 0) {
        return response.status(400).send({ error: "No valid job rows after normalization." });
      }

      console.log(`📥 Received ${jobsRaw.length} jobs; ${normalizedJobs.length} valid after normalization; category: ${category}`);

      // Resolve machine_id from asset_number or machine_name (with normalization)
      const normalizeAsset = (val) => String(val || '').trim().replace(/[-\s]/g, '').toUpperCase();
      const normalizeName = (val) => String(val || '').trim().toLowerCase();

      const db4Promise = db4.promise();
      const [machines] = await db4Promise.query('SELECT machine_id, asset_number, machine_name FROM pmp_machines');
      const assetToId = new Map();
      const nameToId = new Map();
      machines.forEach(m => {
        const aKey = normalizeAsset(m.asset_number);
        const nKey = normalizeName(m.machine_name);
        if (aKey) assetToId.set(aKey, m.machine_id);
        if (nKey) nameToId.set(nKey, m.machine_id);
      });

      const errors = [];
      const valuesToInsert = [];
      const missingMachines = [];

      // First pass: try to match existing machines
      normalizedJobs.forEach((job, idx) => {
        const assetKeyRaw = job.asset_number !== undefined && job.asset_number !== null ? job.asset_number : '';
        const nameKeyRaw = job.machine_name ? job.machine_name : undefined;
        const assetKey = normalizeAsset(assetKeyRaw);
        const nameKey = nameKeyRaw ? normalizeName(nameKeyRaw) : undefined;
        const machineId = (assetKey && assetToId.get(assetKey)) || (nameKey ? nameToId.get(nameKey) : undefined);

        if (!machineId) {
          missingMachines.push({ idx, assetKeyRaw, nameKeyRaw });
          return;
        }

        valuesToInsert.push([
          machineId,
          job.wo_number,
          'Pending',
          category,
          new Date()
        ]);
      });

      // If we have missing machines, attempt to auto-register them in pmp_machines (asset_number + machine_name)
      if (missingMachines.length) {
        const uniqueNewMachines = new Map(); // key: normalized asset|name
        missingMachines.forEach(({ assetKeyRaw, nameKeyRaw }) => {
          const key = `${normalizeAsset(assetKeyRaw)}|${normalizeName(nameKeyRaw)}`;
          if (!uniqueNewMachines.has(key)) {
            uniqueNewMachines.set(key, {
              asset_number: assetKeyRaw || null,
              machine_name: nameKeyRaw || assetKeyRaw || 'Pending Machine',
            });
          }
        });

        const insertRows = Array.from(uniqueNewMachines.values())
          .filter(r => r.asset_number || r.machine_name);

        if (insertRows.length) {
          console.log(`🆕 Attempting to register ${insertRows.length} machines to pmp_machines for unmatched assets/names...`);
          try {
            const sqlInsertMachines = 'INSERT IGNORE INTO pmp_machines (asset_number, machine_name) VALUES ?';
            const rows = insertRows.map(r => [r.asset_number, r.machine_name]);
            await db4Promise.query(sqlInsertMachines, [rows]);
          } catch (e) {
            console.log('⚠️ Auto-register machines failed:', e.message);
          }

          // Refresh maps after attempting inserts
          const [machines2] = await db4Promise.query('SELECT machine_id, asset_number, machine_name FROM pmp_machines');
          assetToId.clear();
          nameToId.clear();
          machines2.forEach(m => {
            const aKey = normalizeAsset(m.asset_number);
            const nKey = normalizeName(m.machine_name);
            if (aKey) assetToId.set(aKey, m.machine_id);
            if (nKey) nameToId.set(nKey, m.machine_id);
          });

          // Retry unmatched rows
          missingMachines.forEach(({ idx, assetKeyRaw, nameKeyRaw }) => {
            const assetKey = normalizeAsset(assetKeyRaw);
            const nameKey = nameKeyRaw ? normalizeName(nameKeyRaw) : undefined;
            const machineId = (assetKey && assetToId.get(assetKey)) || (nameKey ? nameToId.get(nameKey) : undefined);
            const job = normalizedJobs[idx];
            if (machineId && job) {
              valuesToInsert.push([
                machineId,
                job.wo_number,
                'Pending',
                category,
                new Date()
              ]);
            } else {
              errors.push(`Row ${idx}: machine not found for asset ${assetKeyRaw}${nameKeyRaw ? ` / name ${nameKeyRaw}` : ''}`);
            }
          });
        }
      }

      if (valuesToInsert.length === 0) {
        return response.status(400).send({ error: "No valid job rows after machine lookup.", details: errors });
      }

      console.log(`📦 Machine map size: assets=${assetToId.size} names=${nameToId.size}; ready to insert ${valuesToInsert.length} rows (skipped ${errors.length})`);
      if (errors.length) {
        console.log('📄 Sample unmatched rows (first 10):', errors.slice(0, 10));
      }

      // Build INSERT query aligned to table columns
      const sql = `
        INSERT INTO pmp_pending_jobs 
        (machine_id, wo_number, status, category, created_at) 
        VALUES ?
      `;

      db4.query(sql, [valuesToInsert], (err, result) => {
        if (err) {
          console.error('❌ Database Insertion Error:', err.message);
          return response.status(500).send({ 
            error: "Database insertion failed", 
            details: err.message 
          });
        }
        console.log(`✨ Successfully imported ${result.affectedRows} pending jobs.`);
        return response.status(201).send({ 
          message: "Import successful", 
          createdCount: result.affectedRows,
          received: jobsRaw.length,
          normalized: normalizedJobs.length,
          inserted: valuesToInsert.length,
          skippedCount: errors.length,
          skippedSamples: errors.slice(0, 10)
        });
      });

    } catch (error) {
      console.error('❌ Import Error:', error.message);
      return response.status(500).send({ 
        error: "Import processing failed", 
        details: error.message 
      });
    }
  },

readPendingJobs: async (request, response) => {
        const sql = `
            SELECT 
                pj.pending_id, 
                pj.wo_number,
                pj.created_at,
                m.machine_name,
                m.asset_number
            FROM pmp_pending_jobs AS pj
            JOIN pmp_machines AS m ON pj.machine_id = m.machine_id
            WHERE pj.status = 'Pending' -- or 'Assigned', depending on your logic
            ORDER BY pj.wo_number;
        `;
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error:', err.message);
                return response.status(500).send({ error: "Read failed" });
            }
            return response.status(200).send(result);
        });
    },

    createPendingJob: async (request, response) => {
        // Note: We get machine_id directly from the frontend
        const { machine_id, wo_number } = request.body;

        if (!machine_id || !wo_number) {
            return response.status(400).send({ error: "Missing machine_id or wo_number" });
        }
        
        const sql = "INSERT INTO pmp_pending_jobs (machine_id, wo_number, status) VALUES (?, ?, ?)";
        
        db4.query(sql, [machine_id, wo_number, 'Pending'], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return response.status(409).send({ error: "That Work Order number already exists." });
                }
                console.error('❌ Database CREATE Error (pending_job):', err.message);
                return response.status(500).send({ error: "Database insertion failed", details: err.message });
            }
            return response.status(201).send({ message: "Pending job created", insertedId: result.insertId });
        });
    },

    /**
     * UPDATE: Update a pending job (e.g., fix a typo in the WO number)
     * Called by: PUT /part/pending-job/:id
     */
    updatePendingJob: async (request, response) => {
        const { id } = request.params; // This is the 'pending_id'
        const { machine_id, wo_number } = request.body;
        
        const sql = "UPDATE pmp_pending_jobs SET machine_id = ?, wo_number = ? WHERE pending_id = ?";

        db4.query(sql, [machine_id, wo_number, id], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return response.status(409).send({ error: "That Work Order number already exists." });
                }
                console.error('❌ Database UPDATE Error (pending_job):', err.message);
                return response.status(500).send({ error: "Database update failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Job not found" });
            }
            return response.status(200).send({ message: "Pending job updated" });
        });
    },

    /**
     * DELETE: Delete a job from the pending list
     * Called by: DELETE /part/pending-job/:id
     */
    deletePendingJob: async (request, response) => {
        const { id } = request.params; // This is the 'pending_id'
        const sql = "DELETE FROM pmp_pending_jobs WHERE pending_id = ?";
        
        db4.query(sql, [id], (err, result) => {
            if (err) {
                console.error('❌ Database DELETE Error (pending_job):', err.message);
                return response.status(500).send({ error: "Database delete failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Job not found" });
            }
            return response.status(200).send({ message: "Pending job deleted" });
        });
    },

    /**
     * ASSIGN JOBS: This is the core logic.
     * It moves jobs from 'pending' to 'live' work orders.
     * Called by: POST /part/assign-jobs
     */
   assignJobs: async (request, response) => {
        const { jobIds, scheduled_date } = request.body; 

        if (!jobIds || !scheduled_date || jobIds.length === 0) {
            return response.status(400).send({ error: "Missing job IDs or scheduled date." });
        }

        // Get the promise-wrapped version of your single db4 connection
        const db4Promise = db4.promise();
        let assignedCount = 0;
        const errors = [];

        for (const pendingId of jobIds) {
            // We no longer need 'let connection' here
            try {
                // --- THIS IS THE FIX ---
                // We start the transaction directly on the db4 connection
                await db4Promise.beginTransaction(); 

                // 1. Get the pending job info
                const [pendingRows] = await db4Promise.query(
                    'SELECT machine_id, wo_number FROM pmp_pending_jobs WHERE pending_id = ? AND status = ?',
                    [pendingId, 'Pending']
                );

                if (pendingRows.length === 0) {
                    throw new Error(`Job ID ${pendingId} is not pending.`);
                }
                const pendingJob = pendingRows[0];
                const machineId = pendingJob.machine_id;

                // 2. Create the new "live" work order
                const [woResult] = await db4Promise.query(
                    'INSERT INTO pmp_work_orders (machine_id, wo_number, scheduled_date, status) VALUES (?, ?, ?, ?)',
                    [machineId, pendingJob.wo_number, scheduled_date, 'Open']
                );
                const newWorkOrderId = woResult.insertId;

                // 3. Find all default operations
                const [opsToCopy] = await db4Promise.query(
                    'SELECT description FROM pmp_default_operations WHERE machine_id = ?',
                    [machineId]
                );

                // 4. Copy those operations
                if (opsToCopy.length > 0) {
                    const opsPlaceholders = opsToCopy.map(() => '(?, ?)').join(', ');
                    const opsValues = [];
                    opsToCopy.forEach(op => {
                        opsValues.push(newWorkOrderId, op.description);
                    });
                    
                    await db4Promise.query(
                        `INSERT INTO pmp_work_order_operations (work_order_id, description) VALUES ${opsPlaceholders}`,
                        opsValues
                    );
                }

                // 5. Update the pending job to "Assigned"
                await db4Promise.query(
                    "UPDATE pmp_pending_jobs SET status = 'Assigned' WHERE pending_id = ?",
                    [pendingId]
                );

                // 6. Commit changes for THIS job
                await db4Promise.commit();
                assignedCount++;

            } catch (err) {
                // If any step failed, roll back the transaction
                await db4Promise.rollback();
                
                if (err.code === 'ER_DUP_ENTRY') {
                    errors.push(`Failed for WO ${pendingId}: This Work Order number already exists in the live table.`);
                } else {
                    errors.push(`Failed for WO ${pendingId}: ${err.message}`);
                }
            }
            // We don't use 'finally' or 'release()' because 
            // we are re-using the same single connection for the next loop.
        } // End of for...loop

        // --- Response Logic ---
        if (errors.length > 0 && assignedCount === 0) {
            return response.status(409).send({ 
                message: `All ${jobIds.length} jobs failed to assign. See errors.`,
                assignedCount: 0,
                errors: errors,
            });
        }
        if (errors.length > 0) {
            return response.status(207).send({ 
                message: `Assignment partially successful. ${assignedCount} jobs assigned.`,
                assignedCount: assignedCount,
                errors: errors,
            });
        }
        return response.status(201).send({
            message: `Assignment complete. ${assignedCount} jobs assigned.`,
            assignedCount: assignedCount,
            errors: [],
        });
    },

    updatePMPTechnician: async (request, response) => {
        const { id } = request.params;
        
        const { 
            technician_name, 
            technician_note, 
            status,
            start_time,
            completed_time 
        } = request.body;

        // --- THE FIX ---
        // Manually format the date string to 'YYYY-MM-DD HH:MM:SS'
        // This stops Node.js/MySQL driver from doing timezone math (-7 hours).
        const formatDateForSQL = (isoString) => {
            if (!isoString) return null;
            // Takes "2025-11-23T10:30" and makes it "2025-11-23 10:30:00"
            return isoString.replace('T', ' ') + ':00';
        };

        const formattedStart = formatDateForSQL(start_time);
        const formattedComplete = formatDateForSQL(completed_time);

        const sql = `
            UPDATE pmp_work_orders 
            SET 
                technician_name = ?,
                technician_note = ?,
                status = ?,
                start_time = ?, 
                completed_time = ?
            WHERE work_order_id = ?
        `;
        
        db4.query(sql, [technician_name, technician_note, status, formattedStart, formattedComplete, id], (err, result) => {
            if (err) {
                console.error('❌ Database TECH UPDATE Error:', err.message);
                return response.status(500).send({ error: "Database update failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Record not found" });
            }
            return response.status(200).send({ message: "Record updated by technician" });
        });
    },

    getOperationsForWorkOrder: async (request, response) => {
    try {
      const { work_order_id } = request.params;

      // Helper function to run DB queries with Promises (avoids callback hell)
      const queryDB = (sql, params) => {
        return new Promise((resolve, reject) => {
          db4.query(sql, params, (err, res) => {
            if (err) reject(err);
            else resolve(res);
          });
        });
      };

      // 1. First, try to fetch operations specifically saved for this Work Order
      let sql = "SELECT * FROM pmp_work_order_operations WHERE work_order_id = ?";
      let operations = await queryDB(sql, [work_order_id]);

      // 2. If records exist, return them immediately (Technician has already started working)
      if (operations.length > 0) {
        return response.status(200).send(operations);
      }

      // 3. If EMPTY, we need to fetch the DEFAULT operations for the machine.
      // Step 3a: Get the machine_id associated with this work_order_id
      const workOrderResult = await queryDB(
        "SELECT machine_id FROM pmp_work_orders WHERE work_order_id = ?", 
        [work_order_id]
      );

      if (workOrderResult.length === 0) {
        return response.status(404).send({ error: "Work Order not found" });
      }

      const machineId = workOrderResult[0].machine_id;

      // Step 3b: Fetch the default operations template for this machine
      // (Assuming your template table is named 'pmp_default_operations')
      sql = "SELECT * FROM pmp_default_operations WHERE machine_id = ? ORDER BY default_op_id";
      const defaultOps = await queryDB(sql, [machineId]);

      // 4. Return the defaults (The frontend will treat them as new unsaved lines)
      return response.status(200).send(defaultOps);

    } catch (error) {
      console.error('❌ Error fetching operations:', error.message);
      return response.status(500).send({ error: "Server error", details: error.message });
    }
  },

    /**
     * UPDATE: Update a *single* operation's status and note
     * Called by: PUT /part/work-order-operation/:operation_id
     */
   updateWorkOrderOperation: async (request, response) => {
        const { operation_id } = request.params;
        const { technician_note } = request.body; // Only get the note

        const sql = "UPDATE pmp_work_order_operations SET technician_note = ? WHERE operation_id = ?";
        
        db4.query(sql, [technician_note, operation_id], (err, result) => {
            if (err) {
                console.error('❌ Database UPDATE Error (wo_ops):', err.message);
                return response.status(500).send({ error: "Update failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Operation not found" });
            }
            return response.status(200).send({ message: "Operation note updated" });
        });
    },

    unassignWorkOrder: async (request, response) => {
        const { id } = request.params; // This 'id' is the 'work_order_id'
        const db4Promise = db4.promise();
        let connection;

        try {
            connection = await db4Promise.getConnection();
            await connection.beginTransaction(); // START TRANSACTION

            // 1. Get the job's WO Number and Status before deleting
            const [jobRows] = await connection.query(
                'SELECT wo_number, status FROM pmp_work_orders WHERE work_order_id = ?',
                [id]
            );

            if (jobRows.length === 0) {
                throw new Error('Work Order not found.');
            }
            
            const job = jobRows[0];
            
            // 2. Add a business rule: CANNOT unassign a job that's already in progress or finished
            if (job.status !== 'Open') {
                throw new Error(`Cannot unassign job. Status is already '${job.status}'.`);
            }

            // 3. Delete the "live" work order.
            //    This will auto-delete its tasks in 'pmp_work_order_operations'
            await connection.query('DELETE FROM pmp_work_orders WHERE work_order_id = ?', [id]);

            // 4. Update the "pending" job, setting its status back to 'Pending'
            await connection.query(
                "UPDATE pmp_pending_jobs SET status = 'Pending' WHERE wo_number = ?",
                [job.wo_number]
            );

            // 5. If all steps worked, commit the changes
            await connection.commit();
            
            console.log(`✨ Job ${id} (WO: ${job.wo_number}) unassigned and returned to pending list.`);
            return response.status(200).send({ message: `Work Order ${job.wo_number} has been unassigned.` });

        } catch (err) {
            // If any step failed, roll back all changes
            if (connection) await connection.rollback();
            console.error(`Failed to unassign job ${id}:`, err.message);
            return response.status(500).send({ error: `Failed to unassign job: ${err.message}` });
        } finally {
            if (connection) connection.release();
        }
    },

getLiveWorkOrders: async (request, response) => {
        const sql = `
            SELECT 
                -- 1. List the normal columns you need explicitly
                wo.work_order_id,
                wo.machine_id,
                wo.wo_number,
                wo.scheduled_date,
                wo.status,
                wo.technician_name,
                wo.technician_note,
                wo.approved_by,
                wo.approved_date,

                -- 2. THE FIX: Format the time columns as Strings
                -- This stops the timezone conversion (+7 hours / -7 hours)
                DATE_FORMAT(wo.start_time, '%Y-%m-%dT%H:%i') as start_time,
                DATE_FORMAT(wo.completed_time, '%Y-%m-%dT%H:%i') as completed_time,

                -- 3. Get the joined data
                m.machine_name 
            FROM pmp_work_orders AS wo
            LEFT JOIN pmp_machines AS m ON wo.machine_id = m.machine_id
            ORDER BY wo.scheduled_date DESC;
        `;
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (live_work_orders):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },


    createMachine: async (request, response) => {
        const { machine_name, asset_number } = request.body;
        
        const sql = "INSERT INTO pmp_machines (machine_name, asset_number) VALUES (?, ?)";
        
        db4.query(sql, [machine_name, asset_number], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return response.status(409).send({ error: "Duplicate Entry", details: "That Asset Number already exists." });
                }
                console.error('❌ Database CREATE Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database insertion failed", details: err.message });
            }
            console.log(`✨ Machine created with ID: ${result.insertId}`);
            return response.status(201).send({ message: "Machine created", insertedId: result.insertId });
        });
    },

    /**
     * READ: Get all machines
     * Called by: GET /part/machines
     */
    readMachines: async (request, response) => {
        // This is the same as your 'getMachinesList' function
        const sql = "SELECT * FROM pmp_machines ORDER BY machine_name";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    /**
     * UPDATE: Update an existing machine
     * Called by: PUT /part/machines/:id
     */
    updateMachine: async (request, response) => {
        const { id } = request.params;
        const { machine_name, asset_number } = request.body;
        
        const sql = "UPDATE pmp_machines SET machine_name = ?, asset_number = ? WHERE machine_id = ?";
        
        db4.query(sql, [machine_name, asset_number, id], (err, result) => {
            if (err) {
                 if (err.code === 'ER_DUP_ENTRY') {
                    return response.status(409).send({ error: "Duplicate Entry", details: "That Asset Number already exists." });
                }
                console.error('❌ Database UPDATE Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database update failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Machine not found" });
            }
            console.log(`✨ Machine ${id} updated.`);
            return response.status(200).send({ message: "Machine updated" });
        });
    },

    /**
     * DELETE: Delete a machine
     * Called by: DELETE /part/machines/:id
     */
    deleteMachine: async (request, response) => {
        const { id } = request.params;
        const sql = "DELETE FROM pmp_machines WHERE machine_id = ?";
        
        db4.query(sql, [id], (err, result) => {
            if (err) {
                // Handle foreign key constraint error
                if (err.code === 'ER_ROW_IS_REFERENCED_2') {
                     return response.status(409).send({ error: "Cannot delete: Machine is in use", details: "This machine has pending jobs or operations. You must delete them first." });
                }
                console.error('❌ Database DELETE Error (pmp_machines):', err.message);
                return response.status(500).send({ error: "Database delete failed", details: err.message });
            }
            if (result.affectedRows === 0) {
                return response.status(404).send({ error: "Machine not found" });
            }
            console.log(`✨ Machine ${id} deleted.`);
            return response.status(200).send({ message: "Machine deleted" });
        });
    },

    getOpenJobCount: async (request, response) => {
        const sql = "SELECT COUNT(*) as openJobs FROM pmp_work_orders WHERE status = 'Open'";
        
        db4.query(sql, (err, result) => {
            if (err) {
                console.error('❌ Database COUNT Error (work_orders):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            // Send back the count, e.g., { "openJobs": 5 }
            return response.status(200).send(result[0]);
        });
    },

   getCompletedJobs: async (request, response) => {
        // 1. Get the filters
        const { month, year, date } = request.query;

        let sql = `
            SELECT 
                wo.work_order_id,
                wo.wo_number,
                wo.status,
                wo.technician_name,
                wo.approved_by,
                DATE_FORMAT(wo.completed_time, '%Y-%m-%dT%H:%i') as completed_time,
                DATE_FORMAT(wo.approved_date, '%Y-%m-%d') as approved_date,
                m.machine_name 
            FROM pmp_work_orders AS wo
            LEFT JOIN pmp_machines AS m ON wo.machine_id = m.machine_id
            WHERE wo.status = 'Completed'
        `;

        const params = [];

        // 2. Apply Filters (PRIORITY: Date > Month/Year)
        if (date) {
            // If a specific date is provided, filter by that EXACT date
            sql += ` AND DATE(wo.completed_time) = ?`;
            params.push(date);
        } 
        else {
            // Otherwise, check for Month/Year
            if (month && year) {
                sql += ` AND MONTH(wo.completed_time) = ? AND YEAR(wo.completed_time) = ?`;
                params.push(month, year);
            } else if (year) {
                sql += ` AND YEAR(wo.completed_time) = ?`;
                params.push(year);
            }
        }

        // 3. Always sort by newest first
        sql += ` ORDER BY wo.completed_time DESC`;
        
        db4.query(sql, params, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (completed_jobs):', err.message);
                return response.status(500).send({ error: "Read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    getEBRData: async (request, response) => {
        // Get filter parameters from the URL query
        const { start_time, end_time, batch } = request.query;

        // --- 1. Identify the table and connection ---
        // I'm using 'db' (DB_DATABASE1) and the table name from your screenshot.
        // PLEASE VERIFY this is the correct table name.
// --- 1. Identify the table and connection ---
        const TABLE_NAME = "`cMT-GEA-L3_PMA_KWmeter_data`"; 
        const connectionToUse = db; // Using 'db2' for parammachine_saka

        // --- 2. Build the SQL Query (UPDATED) ---
        let params = [];
        let sql = `
            SELECT 
                \`time@timestamp\` as timestamp, 
                data_format_0 as batch_id, 
                data_format_1 as process_id, 
                data_format_2 as 'Chopper RPM',
                data_format_3 as 'Chopper Current',
                data_format_4 as 'Impeller RPM',
                data_format_5 as 'Impeller Current',
                data_format_6 as 'Impeller KWh'
            FROM ${TABLE_NAME}
            WHERE 1=1
        `; // 'WHERE 1=1' is a trick to make appending 'AND' clauses easy

        // Dynamically add filters if they were provided
        if (start_time && end_time) {
            sql += " AND \`time@timestamp\` BETWEEN ? AND ?";
            params.push(start_time, end_time);
        }
        if (batch) {
            sql += " AND data_format_0 = ?";
            params.push(batch);
        }

        sql += " ORDER BY \`time@timestamp\` DESC"; // Show newest first

        // --- 3. Execute the Query (using callback style) ---
        connectionToUse.query(sql, params, (err, result) => {
            if (err) {
                console.error('❌ Database READ Error (EBR Data):', err.message);
                return response.status(500).send({ error: "Database read failed", details: err.message });
            }
            return response.status(200).send(result);
        });
    },

    /**
     * Fetches all combined details for a single Work Order by its WO Number.
     * This is used to auto-fill the entire form.
     */
getWorkOrderDetailsByNumber: async (request, response) => {
        const { wo_number } = request.params;

        // 1. GET MAIN DETAILS
        const mainSql = `
            SELECT 
                w.work_order_id, 
                w.machine_id, 
                w.technician_name, 
                
                -- --- THE FIX IS HERE ---
                -- We format it inside SQL. This prevents Node.js from doing timezone math.
                -- The 'T' in the middle makes it ready for the frontend input.
                DATE_FORMAT(w.start_time, '%Y-%m-%dT%H:%i') as start_time,
                DATE_FORMAT(w.completed_time, '%Y-%m-%dT%H:%i') as completed_time,
                -- -----------------------

                w.scheduled_date, 
                w.approved_by,
                w.approved_date,
                m.asset_number, 
                m.asset_Area, 
                m.gl_Charging, 
                m.asset_Activity, 
                m.wo_description 
            FROM pmp_work_orders w
            JOIN pmp_machines m ON w.machine_id = m.machine_id
            WHERE w.wo_number = ?
        `;

        db4.query(mainSql, [wo_number], (err, mainResult) => {
            if (err) return response.status(500).send({ error: "Read failed", details: err.message });
            if (mainResult.length === 0) return response.status(404).send({ error: "Work Order not found" });

            const mainData = mainResult[0];
            const { work_order_id } = mainData; 

            // 2. GET OPERATIONS 
            const operationsSql = `
                SELECT 
                    operation_id AS id, 
                    description, 
                    technician_note 
                FROM pmp_work_order_operations 
                WHERE work_order_id = ?
                ORDER BY operation_id ASC;
            `;
            
            db4.query(operationsSql, [work_order_id], (opsErr, opsResult) => {
                if (opsErr) return response.status(500).send({ error: "Read failed", details: opsErr.message });

                const responseData = {
                    ...mainData,
                    operations: opsResult 
                };

                return response.status(200).send(responseData);
            });
        });
    },

    approveWorkOrder: async (request, response) => {
        const { wo_number } = request.params;
        const { approver_name } = request.body; // e.g., "Fauzi Perdana"

        // Update the row with the name and CURRENT timestamp
        const sql = `
            UPDATE pmp_work_orders 
            SET approved_by = ?, approved_date = NOW() 
            WHERE wo_number = ?
        `;

        db4.query(sql, [approver_name, wo_number], (err, result) => {
            if (err) {
                console.error("❌ Approval Error:", err);
                return response.status(500).send({ error: "Approval failed" });
            }
            return response.status(200).send({ message: "Work Order Approved", approvedBy: approver_name });
        });
    },

    submitForApproval: async (request, response) => {
        const { wo_number } = request.params;
        
        // Update status to 'Pending Approval'
        const sql = "UPDATE pmp_work_orders SET status = 'Pending Approval' WHERE wo_number = ?";

        db4.query(sql, [wo_number], (err, result) => {
            if (err) return response.status(500).send({ error: "Submission failed" });
            return response.status(200).send({ message: "Submitted for Approval", status: "Pending Approval" });
        });
    },

    // 1. Fetch list of WOs waiting for approval
    getPendingApprovals: async (request, response) => {
        const sql = `
            SELECT 
                w.wo_number, 
                w.scheduled_date, 
                w.technician_name, 
                m.machine_name, 
                m.asset_number
            FROM pmp_work_orders w
            JOIN pmp_machines m ON w.machine_id = m.machine_id
            WHERE w.status = 'Pending Approval'
            ORDER BY w.scheduled_date DESC
        `;

        db4.query(sql, (err, result) => {
            if (err) return response.status(500).send({ error: "Fetch failed" });
            return response.status(200).send(result);
        });
    },

    // 2. Approve Multiple WOs at once
    bulkApproveWorkOrders: async (request, response) => {
        const { wo_numbers } = request.body;

        // 1. Get the user data from the middleware
        // (This works because your middleware did: req.user = verifiedUser)
        const user = request.user; 
        
        // Safety check: In case middleware failed or wasn't used
        if (!user) {
            return response.status(401).send({ error: "User not authenticated" });
        }

        // 2. Get the name. 
        // IMPORTANT: Check your database/login code to see what you called it.
        // It is usually user.username, user.name, or user.fullname.
        const approver_name = user.username || user.name || "Unknown Supervisor";

        if (!wo_numbers || wo_numbers.length === 0) {
            return response.status(400).send({ error: "No WOs selected" });
        }

        const placeholders = wo_numbers.map(() => '?').join(',');
        
        const sql = `
            UPDATE pmp_work_orders 
            SET status = 'Completed', approved_by = ?, approved_date = NOW() 
            WHERE wo_number IN (${placeholders})
        `;

        const params = [approver_name, ...wo_numbers];

        db4.query(sql, params, (err, result) => {
            if (err) return response.status(500).send({ error: "Bulk approval failed" });
            return response.status(200).send({ message: "Selected WOs Approved by " + approver_name });
        });
    },

    getUsers: async (request, response) => {
        const sql = "SELECT id_users, name FROM users WHERE level = 4 ORDER BY name ASC";

        // 1. Check if connection is dead/closed
        if (db.state === 'disconnected' || db4.state === 'protocol_error') {
            console.log("⚠️ DB4 was closed. Reconnecting...");
            db4.connect(); // Force wake up
        }

        try {
            db.query(sql, (err, result) => {
                if (err) {
                    console.error("❌ SQL Error:", err.message);
                    // If it's still closed, we can't do anything but fail
                    return response.status(500).send({ error: "Database connection failed." });
                }
                return response.status(200).send(result);
            });
        } catch (error) {
            console.error("Server Error:", error);
            return response.status(500).send({ error: "Internal Server Error" });
        }
    },


    // GET LIVE WORK ORDERS (Filtered by Token ID)
// GET LIVE WORK ORDERS (Filtered by Token ID)
 liveWorkOrders: async (request, response) => {
      // 1. Get User Info from the Token
      const currentUser = request.user;

      if (!currentUser) {
        return response.status(401).send({ error: "Unauthorized. No token found." });
      }

      // 2. Ensure DB connection is alive
      if (db4.state === 'disconnected' || db4.state === 'protocol_error') {
        console.log("⚠️ DB4 was closed. Reconnecting...");
        db4.connect();
      }

      // console.log(`🔍 Fetching ALL incomplete PWO (user context: ${currentUser.id})`);

      try {
        const sqlAll = `
          SELECT 
            wo.work_order_id,
            wo.wo_number,
            wo.status,
            wo.category,
            wo.scheduled_date,
            wo.technician_id,
            m.machine_name,
            m.asset_number
          FROM pmp_work_orders AS wo
          LEFT JOIN pmp_machines AS m ON wo.machine_id = m.machine_id
          WHERE wo.status != 'Completed'
          AND wo.wo_number LIKE 'PWO%'
          ORDER BY wo.scheduled_date ASC
        `;

        db4.query(sqlAll, [], (err, rows) => {
          if (err) {
            console.error("❌ Error fetching all incomplete PWO:", err);
            return response.status(500).send({ error: err.message });
          }

          console.log(`✅ Successfully fetched ${rows.length} incomplete PWO tasks`);
          return response.status(200).json(rows);
        });

      } catch (error) {
        console.error("❌ Unexpected error in liveWorkOrders:", error);
        return response.status(500).send({ error: error.message });
      }
    },

    // NEW: Only PWO assigned to the logged-in user
    liveWorkOrdersAssigned: async (request, response) => {
      const currentUser = request.user;

      if (!currentUser) {
        return response.status(401).send({ error: "Unauthorized. No token found." });
      }

      if (db4.state === 'disconnected' || db4.state === 'protocol_error') {
        console.log("⚠️ DB4 was closed. Reconnecting...");
        db4.connect();
      }

      // console.log(`🔍 Fetching ASSIGNED incomplete PWO for user ${currentUser.id}`);

      try {
        const sqlMyPwo = `
          SELECT 
            wo.work_order_id,
            wo.wo_number,
            wo.status,
            wo.category,
            wo.scheduled_date,
            wo.technician_id,
            m.machine_name,
            m.asset_number
          FROM pmp_work_orders AS wo
          LEFT JOIN pmp_machines AS m ON wo.machine_id = m.machine_id
          WHERE wo.status != 'Completed'
          AND wo.wo_number LIKE 'PWO%'
          AND wo.technician_id = ?
          ORDER BY wo.scheduled_date ASC
        `;

        db4.query(sqlMyPwo, [currentUser.id], (err, rows) => {
          if (err) {
            console.error("❌ Error fetching assigned PWO:", err);
            return response.status(500).send({ error: err.message });
          }

          // console.log(`✅ Assigned PWO for user ${currentUser.id}: ${rows.length}`);
          return response.status(200).json(rows);
        });

      } catch (error) {
        console.error("❌ Unexpected error in liveWorkOrdersAssigned:", error);
        return response.status(500).send({ error: error.message });
      }
    },
/*
    liveWorkOrders: async (req, res) => {
  try {
    const userId = req.user.id; // Get user ID from token
    console.log('Fetching work orders for user ID:', userId);
    
    // Query work orders assigned to this user
    const query = `
      SELECT * FROM work_orders 
      WHERE assigned_technician_id = ${db.escape(userId)}
      ORDER BY scheduled_date ASC
    `;
    
    db.query(query, (err, result) => {
      if (err) {
        console.error('Error fetching work orders:', err);
        return res.status(500).send({ error: 'Database error' });
      }
      return res.status(200).send(result);
    });
  } catch (error) {
    console.error('Error in liveWorkOrders:', error);
    res.status(500).send({ error: 'Server error' });
  }
},
    */

getTechnicians: async (req, res) => {
    try {
      console.log('\n========== GET TECHNICIANS ==========');
      console.log('Fetching all users with level 4 (technicians)');
      
      const getTechniciansQuery = `SELECT id_users, name, email, username, level, imagePath FROM users WHERE level = 4`;
      
      const technicians = await query(getTechniciansQuery);
      
      console.log(`Found ${technicians.length} technicians`);
      console.log('====================================\n');
      
      return res.status(200).send({
        message: "Technicians fetched successfully",
        data: technicians
      });
    } catch (error) {
      console.error('❌ Error fetching technicians:', error);
      res.status(error.statusCode || 500).send({
        message: 'Error fetching technicians',
        error: error.message
      });
    }
  },

 getVortexData: async (req, res) => {
    try {
      console.log('\n========== GET VORTEX DATA ==========');
      console.log('Fetching all records from vortex_flowmeter');

      // We format the date here so the frontend receives a clean string
      const sql = `
        SELECT 
          id, 
          totalizer, 
          flowmeter, 
          suhu, 
          tekanan, 
          DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') as formatted_date
        FROM vortex_flowmeter 
        ORDER BY created_at ASC
      `;

      const data = await new Promise((resolve, reject) => {
        db3.query(sql, (err, result) => {
          if (err) return reject(err);
          resolve(result);
        });
      });

      console.log(`Found ${data.length} records`);
      console.log('====================================\n');

      return res.status(200).send({
        message: "Vortex data fetched successfully",
        data: data
      });

    } catch (error) {
      console.error('❌ Error fetching vortex data:', error);
      res.status(error.statusCode || 500).send({
        message: 'Error fetching vortex data',
        error: error.message
      });
    }
  },

getOEEAvailability1: async (req, res) => {
    try {
        console.log('\n========== GET OEE AVAILABILITY (TWO-COLUMN MODE) ==========');

        // Simple query: Fetch everything for the shift in one row
        const sql = `
            SELECT 
                MAX(runtime) as max_run,
                MAX(planned_stoptime) as max_planned,
                MIN(planned_stoptime) as min_planned,
                MAX(unplanned_stoptime) as max_unplanned,
                MIN(unplanned_stoptime) as min_unplanned
            FROM fette_machine_dummy 
            WHERE record_time BETWEEN '2025-12-22 06:30:00' AND '2025-12-22 15:00:00'
        `;

        const dbResults = await new Promise((resolve, reject) => {
            db4.query(sql, (err, result) => {
                if (err) return reject(err);
                resolve(result[0]); // Returns the single row of aggregates
            });
        });

        const SHIFT_TOTAL_MINUTES = 510;
        const DATA_INTERVAL = 10; // Change to 1 when machine interval changes

        // 1. Calculate Durations using the Delta logic
        // We add the interval to unplanned to capture the single-row event correctly
        const plannedDowntime = (dbResults.max_planned || 0) - (dbResults.min_planned || 0);
        const unplannedDowntime = (dbResults.max_unplanned || 0) > 0 
            ? (dbResults.max_unplanned - dbResults.min_unplanned) 
            : 0;
            
        // 2. Runtime (Max cumulative value in shift)
        const totalRuntime = dbResults.max_run || 0;

        // 3. Availability Formula: (Runtime - Unplanned - Planned) / (510 - Planned)
        const numerator = totalRuntime - unplannedDowntime;
        const denominator = SHIFT_TOTAL_MINUTES - plannedDowntime;

        let availabilityPercentage = 0;
        if (denominator > 0) {
            availabilityPercentage = (numerator / denominator) * 100;
        }

        return res.status(200).send({
            message: "Availability calculated with new table structure",
            data: {
                runtime: totalRuntime,           // Results in 390
                planned_downtime: plannedDowntime, // Results in 110
                unplanned_downtime: unplannedDowntime, // Results in 10
                availability: availabilityPercentage.toFixed(2) + "%"
            }
        });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).send({ message: 'Error', error: error.message });
    }
},

getOEEPerformance1: async (req, res) => {
    try {
        console.log('\n========== GET & SAVE OEE PERFORMANCE DATA ==========');
        console.log('Calculating Performance for Shift 1 (06:30 - 15:00)');

        // SQL to fetch cumulative totals using your new table structure
        const sqlFetch = `
            SELECT 
                MAX(total_product) as max_product,
                MIN(total_product) as min_product,
                MAX(runtime) as max_run
            FROM fette_machine_dummy 
            WHERE record_time BETWEEN '2025-12-22 06:30:00' AND '2025-12-22 15:00:00'
        `;

        const dbResults = await new Promise((resolve, reject) => {
            db4.query(sqlFetch, (err, result) => {
                if (err) return reject(err);
                resolve(result[0]);
            });
        });

        // --- OEE PERFORMANCE CALCULATION ---
        const TARGET_PER_MINUTE = 5833; 
        
        // 1. Calculate Actual Total Output (Yield)
        const totalOutput = (dbResults.max_product || 0) - (dbResults.min_product || 0);

        // 2. Get Actual Runtime (Matches your frontend key 'actual_runtime')
        const runtime = dbResults.max_run || 0;

        // 3. Calculate Potential Output (Runtime * Target)
        const potentialOutput = runtime * TARGET_PER_MINUTE;

        // 4. Performance Formula
        let performancePercentage = 0;
        if (potentialOutput > 0) {
            performancePercentage = (totalOutput / potentialOutput) * 100;
        }

        const performanceString = performancePercentage.toFixed(2) + "%";

        // --- DATABASE INSERT LOGIC ---
        // Ensuring historical tracking in your new performance log table
        const sqlInsert = `
            INSERT INTO oee_performance_logs_dummy 
            (shift_name, actual_output, actual_runtime, potential_output, performance_value)
            VALUES (?, ?, ?, ?, ?)
        `;
        
        const insertValues = [
            'Shift 1', 
            totalOutput, 
            runtime, 
            potentialOutput, 
            performancePercentage.toFixed(2)
        ];

        await new Promise((resolve, reject) => {
            db4.query(sqlInsert, insertValues, (err, result) => {
                if (err) return reject(err);
                resolve(result);
            });
        });

        console.log(`✅ Performance logged: ${performanceString}`);
        console.log('====================================================\n');

        // Returning the data object with keys that match your frontend
        return res.status(200).send({
            message: "Performance calculated and logged successfully",
            data: {
                actual_output: totalOutput,
                actual_runtime: runtime,
                ideal_target_rate: TARGET_PER_MINUTE,
                potential_output: potentialOutput,
                performance: performanceString
            }
        });

    } catch (error) {
        console.error('❌ Error processing Performance data:', error);
        res.status(500).send({
            message: 'Error processing Performance data',
            error: error.message
        });
    }
},

getOEEQuality1: async (req, res) => {
    try {
        console.log('\n========== GET OEE QUALITY DATA ==========');
        console.log('Calculating Quality for Shift 1 (06:30 - 15:00)');

        // SQL to fetch the cumulative totals for Product and Rejects
        const sql = `
            SELECT 
                MAX(total_product) as max_product,
                MIN(total_product) as min_product,
                MAX(reject) as max_reject,
                MIN(reject) as min_reject
            FROM fette_machine_dummy 
            WHERE record_time BETWEEN '2025-12-22 06:30:00' AND '2025-12-22 15:00:00'
        `;

        const dbResults = await new Promise((resolve, reject) => {
            db4.query(sql, (err, result) => {
                if (err) return reject(err);
                resolve(result[0]);
            });
        });

        // --- OEE QUALITY CALCULATION ---
        
        // 1. Calculate Actual Yield (Total Product produced in shift)
        const totalProduct = dbResults.max_product - dbResults.min_product;

        // 2. Calculate Total Rejects in shift
        const totalRejects = dbResults.max_reject - dbResults.min_reject;

        // 3. Calculate Good Product (Total - Reject)
        const goodProduct = totalProduct - totalRejects;

        // 4. Quality Formula: (Total Product - Reject) / Total Product
        let qualityPercentage = 0;
        if (totalProduct > 0) {
            qualityPercentage = (goodProduct / totalProduct) * 100;
        }

        console.log(`Calculation Complete: ${qualityPercentage.toFixed(2)}%`);
        console.log('==========================================\n');

        return res.status(200).send({
            message: "OEE Quality calculated successfully",
            data: {
                total_product: totalProduct,
                total_rejects: totalRejects,
                good_product: goodProduct,
                quality: qualityPercentage.toFixed(2) + "%"
            }
        });

    } catch (error) {
        console.error('❌ Error calculating Quality data:', error);
        res.status(500).send({
            message: 'Error calculating Quality data',
            error: error.message
        });
    }
},

generateDummyData24H: async (req, res) => {
    try {
        console.log('\n========== GENERATING 24H DATA (WITH SHIFT RESETS) ==========');
        
        // 1. Clear Table
        await new Promise((resolve, reject) => {
            db4.query("TRUNCATE TABLE fette_machine_dummy", (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        // 2. Setup Time Range (Today 06:30 to Tomorrow 06:30)
        const START_TIME = new Date('2025-12-22T06:30:00'); 
        const END_TIME = new Date('2025-12-23T06:30:00');   

        const TARGET_RPM = 1500;
        const PRODUCT_PER_MIN = 5833;

        // 3. Initialize Accumulators
        let accRuntime = 0;
        let accPlanned = 0;
        let accUnplanned = 0;
        let accProduct = 0;
        let accReject = 0;

        let currentTime = new Date(START_TIME);
        let batchValues = [];
        let rowCount = 0;

        // 4. Minute-by-Minute Loop
        while (currentTime <= END_TIME) {
            const hour = currentTime.getHours();
            const minute = currentTime.getMinutes();

            // --- RESET LOGIC (CRITICAL CHANGE) ---
            // If it is exactly the start of Shift 2 or Shift 3, RESET counters to 0
            if (hour === 15 && minute === 0) {
                console.log('🔄 Shift 2 Started: Resetting Counters to 0');
                accRuntime = 0; accPlanned = 0; accUnplanned = 0; accProduct = 0; accReject = 0;
            }
            if (hour === 22 && minute === 45) {
                console.log('🔄 Shift 3 Started: Resetting Counters to 0');
                accRuntime = 0; accPlanned = 0; accUnplanned = 0; accProduct = 0; accReject = 0;
            }
            
            // --- STATE MACHINE ---
            let isRunning = false;
            let isPlannedStop = false;
            let isUnplannedStop = false;

            // SHIFT 1 Logic (06:30 - 15:00)
            if (hour < 15 || (hour === 15 && minute === 0)) {
                if ((hour === 6 && minute >= 30) || (hour === 7 && minute === 0)) isPlannedStop = true; // Briefing
                else if (hour === 10 && minute < 15) isPlannedStop = true; // Break
                else if (hour === 12 && minute >= 15 && minute < 25) isUnplannedStop = true; // Fault
                else isRunning = true;
            }
            // SHIFT 2 Logic (15:00 - 22:45)
            else if (hour < 22 || (hour === 22 && minute <= 45)) {
                if (hour === 15 && minute < 30) isPlannedStop = true; // Handover
                else if (hour === 19 && minute < 30) isPlannedStop = true; // Dinner
                else if (hour === 21 && minute < 5) isUnplannedStop = true; // Jam
                else isRunning = true;
            }
            // SHIFT 3 Logic (22:45 - 06:30)
            else {
                // Logic for crossing midnight
                if ((hour === 22 && minute >= 45) || (hour === 23 && minute < 15)) isPlannedStop = true; // Handover
                else if (hour === 3 && minute < 15) isPlannedStop = true; // Snack
                else if (hour === 5 && minute < 10) isUnplannedStop = true; // Feeder Issue
                else isRunning = true;
            }

            // Override for exact shift boundaries (Handover starts)
            if (hour === 15 && minute === 0) { isPlannedStop = true; isRunning = false; }
            if (hour === 22 && minute === 45) { isPlannedStop = true; isRunning = false; }

            // --- INCREMENT ACCUMULATORS ---
            let rpm = 0;
            if (isRunning) {
                accRuntime += 1; 
                
                // Randomized Product (5400 - 5700)
                const randomProduct = Math.floor(Math.random() * 301) + 5400;
                accProduct += randomProduct;

                // Randomized Rejects (30 - 80)
                const randomReject = Math.floor(Math.random() * 51) + 30;
                accReject += randomReject;
                
                rpm = TARGET_RPM;
            } 
            else if (isPlannedStop) {
                accPlanned += 1;
            } 
            else if (isUnplannedStop) {
                accUnplanned += 1;
            }

            // --- PREPARE SQL ROW ---
            const year = currentTime.getFullYear();
            const month = String(currentTime.getMonth() + 1).padStart(2, '0');
            const day = String(currentTime.getDate()).padStart(2, '0');
            const hourStr = String(hour).padStart(2, '0');
            const minStr = String(minute).padStart(2, '0');
            const sqlTime = `${year}-${month}-${day} ${hourStr}:${minStr}:00`;

            batchValues.push([
                sqlTime, accRuntime, accPlanned, accUnplanned, accProduct, accReject, rpm
            ]);

            // Advance Time
            currentTime.setMinutes(currentTime.getMinutes() + 1);
            rowCount++;
        }

        // 5. Bulk Insert
        const chunkSize = 1000;
        for (let i = 0; i < batchValues.length; i += chunkSize) {
            const chunk = batchValues.slice(i, i + chunkSize);
            const sql = `INSERT INTO fette_machine_dummy (record_time, runtime, planned_stoptime, unplanned_stoptime, total_product, reject, rpm) VALUES ?`;
            
            await new Promise((resolve, reject) => {
                db4.query(sql, [chunk], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
        }

        console.log(`✅ Success: Generated ${rowCount} rows with Shift Resets.`);
        res.status(200).send({ message: "Data generated with shift resets", rows: rowCount });

    } catch (error) {
        console.error('❌ Generation Failed:', error);
        res.status(500).send({ error: error.message });
    }
},

getUniversalOEE: async (req, res) => {
    try {
        // 1. Get parameters from the request (default to Shift 1 and Today)
        const { shift, date } = req.query; 
        const selectedShift = parseInt(shift) || 1;
        const selectedDate = date ? new Date(date) : new Date('2025-12-22'); // Default to your test date
        
        console.log(`\n========== CALCULATING OEE FOR SHIFT ${selectedShift} ==========`);

        // 2. Define Time Ranges dynamically
        let startTime, endTime;
        const year = selectedDate.getFullYear();
        const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
        const day = String(selectedDate.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        // Helper to format date strings
        const nextDay = new Date(selectedDate);
        nextDay.setDate(nextDay.getDate() + 1);
        const nextDayStr = nextDay.toISOString().split('T')[0];

        switch (selectedShift) {
            case 1:
                startTime = `${dateStr} 06:30:00`;
                endTime = `${dateStr} 15:00:00`;
                break;
            case 2:
                startTime = `${dateStr} 15:00:00`;
                endTime = `${dateStr} 22:45:00`;
                break;
            case 3:
                // Shift 3 crosses midnight (Day 1 22:45 to Day 2 06:30)
                startTime = `${dateStr} 22:45:00`;
                endTime = `${nextDayStr} 06:30:00`;
                break;
            default:
                return res.status(400).send({ message: "Invalid Shift ID" });
        }

        console.log(`Time Range: ${startTime} to ${endTime}`);

        // 3. Single Efficient SQL Query
        // Fetches all necessary MIN/MAX values in one go
        const sql = `
            SELECT 
                MAX(runtime) as max_run,
                MIN(runtime) as min_run,
                MAX(total_product) as max_prod,
                MIN(total_product) as min_prod,
                MAX(planned_stoptime) as max_planned,
                MIN(planned_stoptime) as min_planned,
                MAX(unplanned_stoptime) as max_unplanned,
                MIN(unplanned_stoptime) as min_unplanned,
                MAX(reject) as max_reject,
                MIN(reject) as min_reject
            FROM fette_machine_dummy 
            WHERE record_time BETWEEN ? AND ?
        `;

        const dbResults = await new Promise((resolve, reject) => {
            db4.query(sql, [startTime, endTime], (err, result) => {
                if (err) return reject(err);
                resolve(result[0]);
            });
        });

        // 4. --- CALCULATION LOGIC ---

        // Constants
        const TARGET_PER_MINUTE = 5833;
        const SHIFT_MINUTES = (new Date(endTime) - new Date(startTime)) / 1000 / 60; // Auto-calculate duration

        // A. Process Database Values (Delta Calculation)
        const runtime = (dbResults.max_run || 0) - (dbResults.min_run || 0);
        const totalOutput = (dbResults.max_prod || 0) - (dbResults.min_prod || 0);
        const totalRejects = (dbResults.max_reject || 0) - (dbResults.min_reject || 0);
        const plannedDowntime = (dbResults.max_planned || 0) - (dbResults.min_planned || 0);
        const unplannedDowntime = (dbResults.max_unplanned || 0) > 0 
            ? (dbResults.max_unplanned - dbResults.min_unplanned) 
            : 0;

        // B. Calculate Availability (User Formula Correction)
        // Corrected: (Runtime - Unplanned) / (Total Shift Time - Planned)
        const availNumerator = runtime - unplannedDowntime;
        const availDenominator = SHIFT_MINUTES - plannedDowntime;
        
        let availability = 0;
        if (availDenominator > 0) availability = (availNumerator / availDenominator) * 100;

        // C. Calculate Performance
        const potentialOutput = runtime * TARGET_PER_MINUTE;
        let performance = 0;
        if (potentialOutput > 0) performance = (totalOutput / potentialOutput) * 100;

        // D. Calculate Quality
        const goodProduct = totalOutput - totalRejects;
        let quality = 0;
        if (totalOutput > 0) quality = (goodProduct / totalOutput) * 100;

        const oeeScore = (availability * performance * quality) / 10000;

        
        // Return Data (Including variables for the frontend validator)
        res.status(200).send({
            message: `OEE Calculated for Shift ${selectedShift}`,
            shift_info: {
                shift_id: selectedShift,
                duration_minutes: SHIFT_MINUTES
            },
            data: {
              oee: oeeScore.toFixed(2) + "%",
              
                availability: {
                    availability: availability.toFixed(2) + "%",
                    numerator: availNumerator,
                    denominator: availDenominator,
                    // Raw inputs for display
                    runtime: runtime,
                    unplanned_downtime: unplannedDowntime,
                    planned_downtime: plannedDowntime
                },
                performance: {
                    performance: performance.toFixed(2) + "%",
                    actual_output: totalOutput,
                    target_rate: TARGET_PER_MINUTE,
                    actual_runtime: runtime,
                    potential_output: potentialOutput
                },
                quality: {
                    quality: quality.toFixed(2) + "%",
                    total_product: totalOutput,
                    total_rejects: totalRejects,
                    good_product: goodProduct
                }
            }
        });

    } catch (error) {
        console.error('❌ Universal Controller Error:', error);
        res.status(500).send({ message: 'Error calculating OEE', error: error.message });
    }
},

generateDummyDataWeekly: async (req, res) => {
    try {
        console.log('\n========== GENERATING WEEKLY DATA (DEC 22 - DEC 26) ==========');
        
        // 1. Clear Table
        await new Promise((resolve, reject) => {
            db4.query("TRUNCATE TABLE fette_machine_dummy", (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        // 2. Setup Time Range (Monday Morning to Saturday Morning)
        // Ends on Saturday 06:30 so Friday's Shift 3 is complete
        const START_TIME = new Date('2025-12-20T06:30:00'); 
        const END_TIME = new Date('2025-12-27T06:30:00');   

        const TARGET_RPM = 1500;
        
        // 3. Initialize Accumulators
        let accRuntime = 0;
        let accPlanned = 0;
        let accUnplanned = 0;
        let accProduct = 0;
        let accReject = 0;

        let currentTime = new Date(START_TIME);
        let batchValues = [];
        let rowCount = 0;

        // 4. Minute-by-Minute Loop
        while (currentTime <= END_TIME) {
            const hour = currentTime.getHours();
            const minute = currentTime.getMinutes();

            // --- SHIFT RESET LOGIC ---
            // We reset at the start of EVERY shift (S1, S2, S3)
            // 06:30 (Start S1), 15:00 (Start S2), 22:45 (Start S3)
            // Note: We skip the very first 06:30 on Monday to avoid resetting initialized 0s
            const isStart = currentTime.getTime() === START_TIME.getTime();
            
            if (!isStart) {
                if (
                    (hour === 6 && minute === 30) ||  // Start of Day/Shift 1
                    (hour === 15 && minute === 0) ||  // Start of Shift 2
                    (hour === 22 && minute === 45)    // Start of Shift 3
                ) {
                    // console.log(`🔄 Resetting Counters at ${currentTime.toLocaleString()}`);
                    accRuntime = 0; accPlanned = 0; accUnplanned = 0; accProduct = 0; accReject = 0;
                }
            }
            
            // --- STATE MACHINE ---
            let isRunning = false;
            let isPlannedStop = false;
            let isUnplannedStop = false;

            // SHIFT 1 Logic (06:30 - 15:00)
            if (hour < 15 || (hour === 15 && minute === 0)) {
                if ((hour === 6 && minute >= 30) || (hour === 7 && minute === 0)) isPlannedStop = true; // Briefing
                else if (hour === 10 && minute < 15) isPlannedStop = true; // Break
                else if (hour === 12 && minute >= 15 && minute < 25) isUnplannedStop = true; // Fault
                else isRunning = true;
            }
            // SHIFT 2 Logic (15:00 - 22:45)
            else if (hour < 22 || (hour === 22 && minute <= 45)) {
                if (hour === 15 && minute < 30) isPlannedStop = true; // Handover
                else if (hour === 19 && minute < 30) isPlannedStop = true; // Dinner
                else if (hour === 21 && minute < 5) isUnplannedStop = true; // Jam
                else isRunning = true;
            }
            // SHIFT 3 Logic (22:45 - 06:30)
            else {
                if ((hour === 22 && minute >= 45) || (hour === 23 && minute < 15)) isPlannedStop = true; // Handover
                else if (hour === 3 && minute < 15) isPlannedStop = true; // Snack
                else if (hour === 5 && minute < 10) isUnplannedStop = true; // Feeder Issue
                else isRunning = true;
            }

            // Exact Boundary Overrides
            if (hour === 6 && minute === 30) { isPlannedStop = true; isRunning = false; }
            if (hour === 15 && minute === 0) { isPlannedStop = true; isRunning = false; }
            if (hour === 22 && minute === 45) { isPlannedStop = true; isRunning = false; }

            // --- INCREMENT ACCUMULATORS ---
            let rpm = 0;
            if (isRunning) {
                accRuntime += 1; 
                
                // Randomized Product (5500 - 5800)
                const randomProduct = Math.floor(Math.random() * 501) + 5200;
                accProduct += randomProduct;

                // Randomized Rejects (10 - 60)
                const randomReject = Math.floor(Math.random() * 101) + 10;
                accReject += randomReject;
                
                rpm = TARGET_RPM;
            } 
            else if (isPlannedStop) {
                accPlanned += 1;
            } 
            else if (isUnplannedStop) {
                accUnplanned += 1;
            }

            // --- SQL PREP ---
            const year = currentTime.getFullYear();
            const month = String(currentTime.getMonth() + 1).padStart(2, '0');
            const day = String(currentTime.getDate()).padStart(2, '0');
            const hourStr = String(hour).padStart(2, '0');
            const minStr = String(minute).padStart(2, '0');
            const sqlTime = `${year}-${month}-${day} ${hourStr}:${minStr}:00`;

            batchValues.push([
                sqlTime, accRuntime, accPlanned, accUnplanned, accProduct, accReject, rpm
            ]);

            // Advance Time
            currentTime.setMinutes(currentTime.getMinutes() + 1);
            rowCount++;
        }

        // 5. Bulk Insert (Chunks of 2000 to handle the larger load)
        const chunkSize = 2000;
        for (let i = 0; i < batchValues.length; i += chunkSize) {
            const chunk = batchValues.slice(i, i + chunkSize);
            const sql = `INSERT INTO fette_machine_dummy (record_time, runtime, planned_stoptime, unplanned_stoptime, total_product, reject, rpm) VALUES ?`;
            
            await new Promise((resolve, reject) => {
                db4.query(sql, [chunk], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
            console.log(`✅ Inserted chunk ${i} - ${i + chunk.length}`);
        }

        console.log(`🎉 SUCCESS! Generated ${rowCount} rows (Mon-Fri).`);
        res.status(200).send({ message: "Weekly data generated successfully", rows: rowCount });

    } catch (error) {
        console.error('❌ Generation Failed:', error);
        res.status(500).send({ error: error.message });
    }
},

getDailyOEE: async (req, res) => {
    try {
        console.log('\n========== CALCULATING DAILY AGGREGATED OEE ==========');
        const { date } = req.query;
        const selectedDate = date ? new Date(date) : new Date('2025-12-22');
        
        // Helper to format timestamps
        const getDateStr = (d) => d.toISOString().split('T')[0];
        const nextDate = new Date(selectedDate);
        nextDate.setDate(nextDate.getDate() + 1);

        const dayStr = getDateStr(selectedDate);
        const nextDayStr = getDateStr(nextDate);

        // Define the 3 Shift Windows
        const shifts = [
            { id: 1, start: `${dayStr} 06:30:00`, end: `${dayStr} 15:00:00` },
            { id: 2, start: `${dayStr} 15:00:00`, end: `${dayStr} 22:45:00` },
            { id: 3, start: `${dayStr} 22:45:00`, end: `${nextDayStr} 06:30:00` }
        ];

        // 1. Fetch Data for ALL 3 Shifts
        const shiftPromises = shifts.map(shift => {
            const sql = `
                SELECT 
                    MAX(runtime) as max_run, MIN(runtime) as min_run,
                    MAX(total_product) as max_prod, MIN(total_product) as min_prod,
                    MAX(planned_stoptime) as max_planned, MIN(planned_stoptime) as min_planned,
                    MAX(unplanned_stoptime) as max_unplanned, MIN(unplanned_stoptime) as min_unplanned,
                    MAX(reject) as max_reject, MIN(reject) as min_reject
                FROM fette_machine_dummy 
                WHERE record_time BETWEEN ? AND ?
            `;
            return new Promise((resolve, reject) => {
                db4.query(sql, [shift.start, shift.end], (err, result) => {
                    if (err) return reject(err);
                    resolve({ ...result[0], duration_min: (new Date(shift.end) - new Date(shift.start))/60000 });
                });
            });
        });

        const results = await Promise.all(shiftPromises);

        // 2. Aggregate Totals
        let totalRuntime = 0;
        let totalUnplanned = 0;
        let totalPlanned = 0;
        let totalShiftTime = 0;
        let totalOutput = 0;
        let totalRejects = 0;

        results.forEach(r => {
            const sRuntime = (r.max_run || 0) - (r.min_run || 0);
            const sUnplanned = (r.max_unplanned || 0) > 0 ? (r.max_unplanned - r.min_unplanned) : 0;
            const sPlanned = (r.max_planned || 0) - (r.min_planned || 0);
            const sOutput = (r.max_prod || 0) - (r.min_prod || 0);
            const sReject = (r.max_reject || 0) - (r.min_reject || 0);

            totalRuntime += sRuntime;
            totalUnplanned += sUnplanned;
            totalPlanned += sPlanned;
            totalOutput += sOutput;
            totalRejects += sReject;
            totalShiftTime += r.duration_min;
        });

        // 3. Apply Formulas to Daily Totals

        // Availability
        const availNumerator = totalRuntime - totalUnplanned;
        const availDenominator = totalShiftTime - totalPlanned;
        let availability = 0;
        if (availDenominator > 0) availability = (availNumerator / availDenominator) * 100;

        // Performance
        const TARGET_PER_MINUTE = 5833;
        const potentialOutput = totalRuntime * TARGET_PER_MINUTE;
        let performance = 0;
        if (potentialOutput > 0) performance = (totalOutput / potentialOutput) * 100;

        // Quality
        const goodProduct = totalOutput - totalRejects;
        let quality = 0;
        if (totalOutput > 0) quality = (goodProduct / totalOutput) * 100;

        // --- 4. CALCULATE DAILY OEE SCORE ---
        // Formula: (Avail * Perf * Qual) / 10000
        const oeeScore = (availability * performance * quality) / 10000;

        console.log(`Daily OEE: ${oeeScore.toFixed(2)}%`);

        res.status(200).send({
            message: `Daily Aggregated OEE for ${dayStr}`,
            date: dayStr,
            data: {
                // THIS WAS LIKELY MISSING IN YOUR PREVIOUS CODE:
                oee: oeeScore.toFixed(2) + "%",

                availability: {
                    value: availability.toFixed(2) + "%",
                    total_runtime: totalRuntime,
                    total_unplanned: totalUnplanned,
                    total_planned: totalPlanned,
                    total_shift_time: totalShiftTime
                },
                performance: {
                    value: performance.toFixed(2) + "%",
                    total_output: totalOutput,
                    potential_output: potentialOutput
                },
                quality: {
                    value: quality.toFixed(2) + "%",
                    total_output: totalOutput,
                    total_rejects: totalRejects,
                    good_product: goodProduct
                }
            }
        });

    } catch (error) {
        console.error('❌ Daily OEE Error:', error);
        res.status(500).send({ message: 'Error calculating Daily OEE', error: error.message });
    }
},

// SINGLE ARCHIVE (Existing)
    archiveCombinedOEE: async (req, res) => {
        try {
            const { date, shift } = req.query;
            if (!date || !shift) return res.status(400).send({ message: "Missing params" });
            const result = await processArchiveForShift(date, parseInt(shift));
            res.status(200).send({ message: "Archived", data: result });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: error.message });
        }
    },

    // BULK ARCHIVE (New)
    // BULK ARCHIVE
    archiveAll: async (req, res) => {
        try {
            console.log("🚀 STARTING BULK ARCHIVE...");
            
            // 1. Find all unique dates
            const dates = await new Promise((resolve, reject) => {
                db4.query("SELECT DISTINCT DATE(record_time) as d FROM fette_machine_dummy ORDER BY d ASC", (err, res) => {
                    if (err) return reject(err);
                    
                    // --- THE FIX IS HERE ---
                    // Instead of toISOString() which shifts to UTC (and previous day),
                    // We construct the local YYYY-MM-DD string manually to preserve the date.
                    const localDates = res.map(row => {
                        const d = new Date(row.d);
                        const offset = d.getTimezoneOffset() * 60000; // Offset in milliseconds
                        const localDate = new Date(d.getTime() - offset);
                        return localDate.toISOString().split('T')[0];
                    });
                    
                    resolve(localDates);
                });
            });

            console.log(`Found ${dates.length} days with data:`, dates);

            // 2. Iterate and Archive
            let count = 0;
            for (const dateStr of dates) {
                await processArchiveForShift(dateStr, 1);
                await processArchiveForShift(dateStr, 2);
                await processArchiveForShift(dateStr, 3);
                process.stdout.write(`.`); 
                count += 3;
            }

            console.log(`\n✅ Bulk Archive Complete! Processed ${count} shifts.`);
            res.status(200).send({ message: `Successfully archived ${count} shifts across ${dates.length} days.` });

        } catch (error) {
            console.error("Bulk Archive Error:", error);
            res.status(500).send({ error: error.message });
        }
    },

getWeeklyTrend: async (req, res) => {
        try {
            console.log('\n📈 Fetching Weekly Trend Data (Last 7 Days)...');

            // THE FIX:
            // 1. Inner Query (sub): Grabs the 7 NEWEST entries (ORDER BY DESC LIMIT 7)
            // 2. Outer Query: Re-sorts them correctly for the chart (ORDER BY ASC)
            
            const sql = `
                SELECT * FROM (
                    SELECT 
                        production_date,
                        oee_value_daily AS oee_score,
                        availability_value_daily AS availability,
                        performance_value_daily AS performance,
                        quality_value_daily AS quality
                    FROM oee_master_logs
                    WHERE id IN (
                        SELECT MAX(id)
                        FROM oee_master_logs
                        GROUP BY DATE(production_date)
                    )
                    ORDER BY production_date DESC
                    LIMIT 7
                ) AS sub
                ORDER BY production_date ASC
            `;

            db4.query(sql, (err, result) => {
                if (err) {
                    console.error("SQL Error:", err);
                    return res.status(500).send({ error: err.message });
                }
                res.status(200).send({ data: result });
            });

        } catch (error) {
            console.error('❌ Trend Error:', error);
            res.status(500).send({ error: error.message });
        }
    },
    
getHistoryLog: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;
            console.log(`\n📜 Generating History Log (${startDate} to ${endDate})...`);
            
            // 1. Get Dates from Log
            let logSql = `
                SELECT 
                    DATE(production_date) as date_obj,
                    DATE_FORMAT(production_date, '%Y-%m-%d') as date_str,
                    MAX(oee_value_daily) as daily_oee,
                    MAX(availability_value_daily) as daily_avail,
                    MAX(performance_value_daily) as daily_perf,
                    MAX(quality_value_daily) as daily_qual
                FROM oee_master_logs
            `;
            
            const params = [];
            if (startDate && endDate) {
                logSql += ` WHERE production_date BETWEEN ? AND ?`;
                params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
            }
            logSql += ` GROUP BY DATE(production_date) ORDER BY production_date ASC`;

            const logResults = await new Promise((resolve, reject) => {
                db4.query(logSql, params, (err, res) => err ? reject(err) : resolve(res));
            });

            // 2. Calculate Raw Data from 'fette_machine_dummy'
            const combinedData = await Promise.all(logResults.map(async (row) => {
                const dayStr = row.date_str;
                
                // Define 24h window (06:30 today -> 06:30 tomorrow)
                const nextDay = new Date(dayStr);
                nextDay.setDate(nextDay.getDate() + 1);
                const end = `${nextDay.toISOString().split('T')[0]} 06:30:00`;

                const shifts = [
                   { s: `${dayStr} 06:30:00`, e: `${dayStr} 15:00:00` },
                   { s: `${dayStr} 15:00:00`, e: `${dayStr} 22:45:00` },
                   { s: `${dayStr} 22:45:00`, e: `${end}` }
                ];

                let dailyRun = 0;
                let dailyStop = 0;
                let dailyOut = 0;
                let dailyRej = 0;

                for (const shift of shifts) {
                    // --- THE FIX IS HERE ---
                    // Instead of querying 'stoptime', we calculate it:
                    // Stop Time = (Max Unplanned - Min Unplanned) + (Max Planned - Min Planned)
                    const rawSql = `
                        SELECT 
                            MAX(runtime) - MIN(runtime) as s_run,
                            (MAX(unplanned_stoptime) - MIN(unplanned_stoptime)) + 
                            (MAX(planned_stoptime) - MIN(planned_stoptime)) as s_stop,
                            
                            MAX(total_product) - MIN(total_product) as s_prod,
                            MAX(reject) - MIN(reject) as s_rej
                        FROM fette_machine_dummy 
                        WHERE record_time BETWEEN ? AND ?
                    `;
                    const rawRes = await new Promise((resolve) => {
                        db4.query(rawSql, [shift.s, shift.e], (err, res) => resolve(res[0] || {}));
                    });

                    dailyRun += (rawRes.s_run || 0);
                    dailyStop += (rawRes.s_stop || 0); // Now this will contain data!
                    dailyOut += (rawRes.s_prod || 0);
                    dailyRej += (rawRes.s_rej || 0);
                }

                return {
                    ...row,
                    total_run: dailyRun,
                    total_stop: dailyStop,
                    total_out: dailyOut,
                    total_reject: dailyRej
                };
            }));

            res.status(200).send({ data: combinedData });

        } catch (error) {
            console.error("History Error:", error);
            res.status(500).send({ error: error.message });
        }
    },

    // --- Get Assigned Jobs ---
// --- Get Assigned Jobs ---
// --- Get Assigned Jobs ---
  // --- Get Assigned Jobs (Cross-Server Application Join) ---
  getAssignedJobs: async (request, response) => {
    try {
      // Helper to wrap database queries in Promises (avoids callback hell)
      const queryDB = (connection, sql, params = []) => {
        return new Promise((resolve, reject) => {
          connection.query(sql, params, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
      };

      // 1. Fetch Work Orders from DB4 (EMS Database)
      const workOrderSql = `
        SELECT 
          wo.work_order_id AS id,
          wo.wo_number,
          wo.scheduled_date,
          wo.technician_id,
          wo.status,
          pm.machine_name,
          pm.asset_number
        FROM pmp_work_orders wo
        JOIN pmp_machines pm ON wo.machine_id = pm.machine_id
        ORDER BY wo.scheduled_date DESC
      `;
      
      const jobs = await queryDB(db4, workOrderSql);

      // 2. Extract unique Technician IDs
      const technicianIds = [...new Set(
        jobs
          .map(job => job.technician_id)
          .filter(id => id !== null && id !== undefined) // Remove nulls
      )];

      // 3. If there are technicians assigned, fetch their names from DB (User Database)
      let users = [];
      if (technicianIds.length > 0) {
        // Create placeholders (?,?,?) for the IN clause
        const placeholders = technicianIds.map(() => '?').join(',');
        
        const userSql = `
          SELECT id_users, name 
          FROM users 
          WHERE id_users IN (${placeholders})
        `;
        
        users = await queryDB(db, userSql, technicianIds);
      }

      // 4. Merge the Data (Attach names to jobs)
      const mergedJobs = jobs.map(job => {
        const technician = users.find(user => user.id_users === job.technician_id);
        return {
          ...job,
          technician_name: technician ? technician.name : "Unassigned" // Default if not found
        };
      });

      return response.status(200).send(mergedJobs);

    } catch (error) {
      console.error('❌ getAssignedJobs Error:', error.message);
      return response.status(500).send({ error: "Server error" });
    }
  },

  // --- Update Assigned Job ---
  updateAssignedJob: async (request, response) => {
    try {
      // 'pmp_id' from frontend maps to 'work_order_id' in DB
      const { pmp_id, scheduled_date, technician_id } = request.body;

      if (!pmp_id || !scheduled_date) {
        return response.status(400).send({ error: "Missing required fields: pmp_id, scheduled_date" });
      }

      // UPDATED: Updating the new table using 'work_order_id'
      const sql = `
        UPDATE pmp_work_orders 
        SET scheduled_date = ?, technician_id = ?
        WHERE work_order_id = ?
      `;

      db4.query(sql, [scheduled_date, technician_id || null, pmp_id], (err, result) => {
        if (err) {
          console.error('❌ Error updating assigned job:', err.message);
          return response.status(500).send({ error: "Failed to update job" });
        }

        if (result.affectedRows === 0) {
          return response.status(404).send({ error: "Job not found" });
        }

        console.log(`✅ Updated WO ID ${pmp_id}: date=${scheduled_date}, tech=${technician_id}`);
        return response.status(200).send({ message: "Job updated successfully" });
      });
    } catch (error) {
      console.error('❌ updateAssignedJob Error:', error.message);
      return response.status(500).send({ error: "Server error" });
    }
  },




  

}