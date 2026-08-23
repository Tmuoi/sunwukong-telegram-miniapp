const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { Redis } = require("@upstash/redis");

const app = express();// CORS - cho phép Mini App trên Vercel gọi API Render
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "20kb" }));

// ===============================
// 1. KẾT NỐI SUPABASE
// ===============================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===============================
// 2. KẾT NỐI REDIS
// ===============================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

// ===============================
// 3. KIỂM TRA TELEGRAM INIT DATA
// ===============================

function verifyTelegramInitData(initData) {
  try {
    if (!initData) return null;

    const params = new URLSearchParams(initData);
    const receivedHash = params.get("hash");

    if (!receivedHash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (calculatedHash !== receivedHash) {
      return null;
    }

    const userString = params.get("user");

    if (!userString) return null;

    return JSON.parse(userString);

  } catch (error) {
    console.error("Telegram verification error:", error);
    return null;
  }
}

// ===============================
// 4. RATE LIMIT REDIS
// ===============================

async function rateLimit(userId) {
  const key = `rate:${userId}`;

  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, 60);
  }

  // Tối đa 60 request/phút/người chơi
  return count <= 60;
}

// ===============================
// 5. HEALTH CHECK
// ===============================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sun Wukong API đang hoạt động"
  });
});

// ===============================
// 6. LẤY THÔNG TIN NGƯỜI CHƠI
// ===============================

app.get("/api/player", async (req, res) => {
  try {

    const initData = req.headers["x-telegram-init-data"];

    const user = verifyTelegramInitData(initData);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Telegram xác thực không hợp lệ"
      });
    }

    if (!(await rateLimit(user.id))) {
      return res.status(429).json({
        success: false,
        message: "Bạn thao tác quá nhanh"
      });
    }

    const { data, error } = await supabase
      .from("players")
      .select("telegram_id, username, level, gold, exp")
      .eq("telegram_id", user.id)
      .maybeSingle();

    if (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message: "Lỗi cơ sở dữ liệu"
      });
    }

    // Người chơi mới
    if (!data) {

      const newPlayer = {
        telegram_id: user.id,
        username: user.username || null,
        level: 1,
        gold: 0,
        exp: 0
      };

      const { data: created, error: createError } = await supabase
        .from("players")
        .insert(newPlayer)
        .select()
        .single();

      if (createError) {
        console.error(createError);

        return res.status(500).json({
          success: false,
          message: "Không tạo được người chơi"
        });
      }

      return res.json({
        success: true,
        player: created
      });
    }

    return res.json({
      success: true,
      player: data
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Lỗi máy chủ"
    });
  }
});

// ===============================
// 7. CỘNG VÀNG
// ===============================

app.post("/api/player/gold", async (req, res) => {
  try {

    const initData = req.headers["x-telegram-init-data"];

    const user = verifyTelegramInitData(initData);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Telegram xác thực không hợp lệ"
      });
    }

    if (!(await rateLimit(user.id))) {
      return res.status(429).json({
        success: false,
        message: "Bạn thao tác quá nhanh"
      });
    }

    const amount = Number(req.body.amount);

    // Không cho client gửi số vàng vô hạn
    if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
      return res.status(400).json({
        success: false,
        message: "Số vàng không hợp lệ"
      });
    }

    const { data: player, error: findError } = await supabase
      .from("players")
      .select("gold")
      .eq("telegram_id", user.id)
      .single();

    if (findError || !player) {
      return res.status(404).json({
        success: false,
        message: "Không tìm thấy người chơi"
      });
    }

    const newGold = player.gold + amount;

    const { data, error } = await supabase
      .from("players")
      .update({
        gold: newGold
      })
      .eq("telegram_id", user.id)
      .select("telegram_id, level, gold, exp")
      .single();

    if (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message: "Không cập nhật được vàng"
      });
    }

    return res.json({
      success: true,
      player: data
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Lỗi máy chủ"
    });
  }
});

// ===============================
// 8. CHẠY SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Sun Wukong API đang chạy tại port ${PORT}`);
});
