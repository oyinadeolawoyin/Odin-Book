const express = require("express");
require("dotenv").config();
const app = express();
const cookieParser = require("cookie-parser");
const cors = require("cors");
const multer = require("multer");
// require('./cronJobs');

const authRoutes = require("./src/routes/authRoutes");
const writingPlan = require("./src/routes/writingPlanRoutes");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// const corsOptions = {
// origin: ["https://thevoices.netlify.app", "http://localhost:5173", "http://localhost:5174", "https://thevoices-admin.netlify.app", "https://thevoices-gamma.vercel.app"], 
// methods: ['GET','POST','PUT','DELETE','OPTIONS'],
// credentials: true,
// };

// Enable CORS globally
// app.use(cors(corsOptions));

app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/writingPlan", writingPlan);


app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === "Unsupported file type") {
    return res.status(400).json({ message: err.message });
    }
    res.status(500).json({ message: err.message });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));