const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '../src');

function fixFile(filePath, depth) {
    let content = fs.readFileSync(filePath, 'utf-8');
    
    // Si el archivo ya usa import { prisma }, lo saltamos
    if (content.includes('import { prisma }')) return;

    // Removemos const prisma = new PrismaClient();
    content = content.replace(/const prisma = new PrismaClient\(\);?\n?/g, '');
    
    // Calculamos el relative path a src/db/prisma.ts
    const relPath = depth === 1 ? '../db/prisma.js' : depth === 2 ? '../../db/prisma.js' : './db/prisma.js';
    
    // Insertamos import { prisma } en la parte de los imports
    if (content.includes('import ')) {
        const lines = content.split('\n');
        const lastImportIdx = lines.findLastIndex(l => l.startsWith('import '));
        lines.splice(lastImportIdx + 1, 0, `import { prisma } from '${relPath}';`);
        content = lines.join('\n');
    } else {
        content = `import { prisma } from '${relPath}';\n` + content;
    }

    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`Fixed: ${filePath}`);
}

function traverse(dir, depth = 1) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) {
            traverse(p, depth + 1);
        } else if (p.endsWith('.ts') && !p.endsWith('index.ts') && !p.endsWith('db.types.ts')) {
            if (fs.readFileSync(p, 'utf-8').includes('new PrismaClient()')) {
                fixFile(p, depth);
            }
        }
    }
}

traverse(path.join(srcDir, 'scrapers'), 1);
traverse(path.join(srcDir, 'jobs'), 1);
traverse(path.join(srcDir, 'services'), 1);
