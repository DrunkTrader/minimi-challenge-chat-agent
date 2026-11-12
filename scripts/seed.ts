import { seedDemo } from "../src/seed.js";

// Re-creates the backdated demo conversations (your own chats are kept).
// Optional: TZ_OFFSET=-330 npm run seed  (minutes, like Date#getTimezoneOffset)
const tz = process.env.TZ_OFFSET ? Number(process.env.TZ_OFFSET) : new Date().getTimezoneOffset();
console.log(`Seeded ${seedDemo(undefined, tz)} demo conversations.`);
