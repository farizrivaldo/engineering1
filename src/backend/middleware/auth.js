const jwt = require("jsonwebtoken");

const veryfyToken = (req, res, next) => {
  let token = req.headers.authorization;

  if (!token) {
    return res.status(401).send("access dnied");
  }
  token = token.split(" ")[1];
  if (token == "null" || !token) {
    return res.status(401).send("access dnied");
  }

  //==============================================================
  try {
    // Verifikasi token
    const verifiedUser = jwt.verify(token, "khaerul");
    req.user = verifiedUser;
    //console.log(verifiedUser); // Log user yang diverifikasi
    next();
  } catch (err) {
    // Tangani error token, termasuk jika expired
    if (err.name === "TokenExpiredError") {
      return res.status(401).send("Token expired. Please login again.");
      next();
    }
    return res.status(401).send("Access denied. Invalid token.");
    next();
  }

  //==============================================================

  // let verifiedUser = jwt.verify(token, "khaerul");
  // console.log(verifiedUser);
  // if (!verifiedUser) {
  //   return res.status(401).send("access dnied");
  // }

  // req.user = verifiedUser;
  // console.log(verifiedUser);
  // next();
};

const checkRole = async (req, res, next) => {
  if (req.user.isAdmin) {
    return next();
  }
  return res.status(401).send("access dnied");
};

module.exports = { veryfyToken, checkRole };
