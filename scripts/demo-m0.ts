import "./load-env.js";
import { Api } from "grammy";
import { DateTime } from "luxon";
import { APP_TIMEZONE } from "../src/config/constants.js";
import { telegramEnv } from "../src/config/env.js";

const env = telegramEnv();
const date = DateTime.now().setZone(APP_TIMEZONE).setLocale("en").toFormat("cccc d LLLL yyyy");
await new Api(env.TELEGRAM_BOT_TOKEN).sendMessage(
  env.ALLOWED_TELEGRAM_USER_ID,
  `GymBot setup OK — ${date}`,
);
console.log("Message sent.");
