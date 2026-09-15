import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dbDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(dbDirectory, "init.sql");
const outputPath = path.join(dbDirectory, "init.supabase.sql");

const source = await readFile(sourcePath, "utf8");
const includePattern = /^\s*\\ir\s+(.+?)\s*$/gm;
const includes = [...source.matchAll(includePattern)];

if (includes.length === 0) {
  throw new Error("No se encontraron instrucciones \\ir en db/init.sql.");
}

let cursor = 0;
const parts = [
  "-- ============================================================================\n",
  "-- ARCHIVO GENERADO PARA SUPABASE\n",
  "-- Fuente: db/init.sql + archivos referenciados mediante \\ir\n",
  "-- No editar manualmente; ejecutar: node db/build-init-supabase.mjs\n",
  "-- Uso previsto: una base de datos nueva y vacía.\n",
  "-- ============================================================================\n\n",
];

for (const match of includes) {
  parts.push(source.slice(cursor, match.index));

  const relativeInclude = match[1].trim();
  const includePath = path.resolve(dbDirectory, relativeInclude);
  const relativeToDb = path.relative(dbDirectory, includePath);

  if (relativeToDb.startsWith("..") || path.isAbsolute(relativeToDb)) {
    throw new Error(`La inclusión sale del directorio db: ${relativeInclude}`);
  }

  const includedSql = await readFile(includePath, "utf8");
  parts.push(
    `\n-- >>> INICIO ARCHIVO INCLUIDO: db/${relativeInclude.replaceAll("\\", "/")}\n`,
    includedSql.trimEnd(),
    `\n-- <<< FIN ARCHIVO INCLUIDO: db/${relativeInclude.replaceAll("\\", "/")}\n`,
  );

  cursor = match.index + match[0].length;
}

parts.push(source.slice(cursor));

const generated = parts.join("").replaceAll("\r\n", "\n");
await writeFile(outputPath, generated, "utf8");

console.log(`Generado ${path.relative(process.cwd(), outputPath)} con ${includes.length} inclusiones.`);
