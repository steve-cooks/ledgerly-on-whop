// Loads .env.local for scripts run with tsx (Next.js loads it automatically for the app).
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
