import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const envFiles = ['.env.local', '.env.development', '.env'];
let loadedFile = null;

for (const file of envFiles) {
  const filePath = path.resolve(process.cwd(), file);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath });
    loadedFile = file;
    break;
  }
}

if (loadedFile) {
  console.log(`[ENV] Environment variables loaded from: ${loadedFile}`);
} else {
  console.log('[ENV] No env file (.env, .env.local, .env.development) found in root directory.');
}

console.log(`SUPABASE_SERVICE_ROLE_KEY loaded: ${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'YES' : 'NO'}`);
