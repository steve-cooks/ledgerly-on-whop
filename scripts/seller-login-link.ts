// Prints a demo sign-in link for a seller: pnpm tsx scripts/seller-login-link.ts seller_us_mira
import "./_setup";
import { signedLoginToken } from "@/lib/seller-session";
console.log(`${process.env.APP_URL}/demo/login?t=${encodeURIComponent(signedLoginToken(process.argv[2]))}`);
