const fetch = require("node-fetch");

let memoryContext = []; // Lưu ngữ cảnh, tối đa 10 tin nhắn gần nhất

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt required" });
    }

    // Thêm prompt vào memory
    memoryContext.push({ role: "user", content: prompt });
    if (memoryContext.length > 10) memoryContext.shift(); // Giữ tối đa 10 mục

    // Tạo payload gửi đến Groq API
    const payload = {
      n: 1,
      prompt: memoryContext.map(m => m.content).join("\n"),
      temperature: 0.7,
      top_p: 0.2
    };

    const response = await fetch("https://api.groq.com/v1/predict", { // thay bằng endpoint Groq thực
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // Lưu phản hồi vào memory
    if (data.choices && data.choices[0] && data.choices[0].message) {
      memoryContext.push({ role: "bot", content: data.choices[0].message.content });
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal Server Error" });
  }
};
