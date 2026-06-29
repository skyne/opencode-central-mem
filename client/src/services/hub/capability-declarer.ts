import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Capability {
  name: string;
  description: string;
  confidence: number;
}

const CAPABILITY_PATTERNS: Array<{
  file: string;
  capability: string;
  description: string;
  confidence: number;
}> = [
  { file: "package.json", capability: "node", description: "Node.js development", confidence: 0.8 },
  { file: "package.json", capability: "typescript", description: "TypeScript development", confidence: 0.8 },
  { file: "tsconfig.json", capability: "typescript", description: "TypeScript project", confidence: 0.9 },
  { file: "Cargo.toml", capability: "rust", description: "Rust development", confidence: 0.9 },
  { file: "Cargo.toml", capability: "backend", description: "Rust backend", confidence: 0.7 },
  { file: "pyproject.toml", capability: "python", description: "Python development", confidence: 0.8 },
  { file: "requirements.txt", capability: "python", description: "Python project", confidence: 0.7 },
  { file: "go.mod", capability: "go", description: "Go development", confidence: 0.9 },
  { file: "go.sum", capability: "go", description: "Go project", confidence: 0.8 },
  { file: "Gemfile", capability: "ruby", description: "Ruby development", confidence: 0.8 },
  { file: "build.gradle", capability: "java", description: "Java/Gradle project", confidence: 0.7 },
  { file: "pom.xml", capability: "java", description: "Java/Maven project", confidence: 0.7 },
  { file: "CMakeLists.txt", capability: "cpp", description: "C++ development", confidence: 0.8 },
  { file: "composer.json", capability: "php", description: "PHP development", confidence: 0.8 },
  { file: "Dockerfile", capability: "docker", description: "Docker containerization", confidence: 0.8 },
  { file: "docker-compose.yml", capability: "docker", description: "Docker Compose orchestration", confidence: 0.7 },
  { file: "Makefile", capability: "build-tools", description: "Build automation", confidence: 0.6 },
  { file: "justfile", capability: "build-tools", description: "Build automation (just)", confidence: 0.6 },
  { file: ".github/workflows", capability: "ci-cd", description: "GitHub Actions CI/CD", confidence: 0.7 },
  { file: "k8s", capability: "kubernetes", description: "Kubernetes deployment", confidence: 0.7 },
  { file: "terraform", capability: "infrastructure", description: "Terraform infrastructure", confidence: 0.7 },
  { file: "react", capability: "frontend", description: "React frontend development", confidence: 0.8 },
  { file: "vue", capability: "frontend", description: "Vue.js frontend development", confidence: 0.8 },
  { file: "angular", capability: "frontend", description: "Angular frontend development", confidence: 0.8 },
  { file: "svelte", capability: "frontend", description: "Svelte frontend development", confidence: 0.8 },
  { file: "next.config", capability: "frontend", description: "Next.js development", confidence: 0.8 },
  { file: "vite.config", capability: "build-tools", description: "Vite build tooling", confidence: 0.7 },
];

function scanDirectory(directory: string, pattern: string): boolean {
  const fullPath = join(directory, pattern);
  if (existsSync(fullPath)) return true;
  try {
    const files = readFileSync(join(directory, "."), "utf-8");
    return files.includes(pattern);
  } catch {
    return false;
  }
}

function detectFromPackageJson(directory: string): Capability[] {
  const pkgPath = join(directory, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const caps: Capability[] = [];
    const deps: Record<string, string> = { ...pkg.dependencies || {}, ...pkg.devDependencies || {} };

    if (deps["react"] || deps["next"] || deps["vue"] || deps["angular"]) {
      caps.push({ name: "frontend", description: "Frontend framework detected in package.json", confidence: 0.8 });
    }
    if (deps["express"] || deps["fastify"] || deps["hono"] || deps["koa"]) {
      caps.push({ name: "backend", description: "Backend framework detected in package.json", confidence: 0.8 });
    }
    if (deps["jest"] || deps["vitest"] || deps["mocha"] || deps["cypress"] || deps["playwright"]) {
      caps.push({ name: "testing", description: "Testing framework detected in package.json", confidence: 0.9 });
    }
    if (deps["prisma"] || deps["typeorm"] || deps["drizzle"] || deps["mongoose"]) {
      caps.push({ name: "database", description: "Database ORM detected in package.json", confidence: 0.7 });
    }
    if (deps["eslint"] || deps["prettier"] || deps["biome"]) {
      caps.push({ name: "linting", description: "Linting/formatting tools", confidence: 0.6 });
    }
    if (deps["tailwindcss"] || deps["sass"] || deps["styled-components"]) {
      caps.push({ name: "styling", description: "CSS/styling frameworks", confidence: 0.6 });
    }
    if (deps["graphql"] || deps["apollo"]) {
      caps.push({ name: "graphql", description: "GraphQL API development", confidence: 0.7 });
    }

    return caps;
  } catch {
    return [];
  }
}

export function detectCapabilities(directory: string): Capability[] {
  const detected = new Map<string, Capability>();

  for (const pattern of CAPABILITY_PATTERNS) {
    if (scanDirectory(directory, pattern.file)) {
      const existing = detected.get(pattern.capability);
      if (!existing || pattern.confidence > existing.confidence) {
        detected.set(pattern.capability, { name: pattern.capability, description: pattern.description, confidence: pattern.confidence });
      }
    }
  }

  for (const cap of detectFromPackageJson(directory)) {
    const existing = detected.get(cap.name);
    if (!existing || cap.confidence > existing.confidence) {
      detected.set(cap.name, cap);
    }
  }

  return Array.from(detected.values());
}

export function mergeCapabilities(
  detected: Capability[],
  overrides?: { add?: string[]; remove?: string[]; confidence?: Record<string, number> }
): Capability[] {
  if (!overrides) return detected;

  let result = detected;

  if (overrides.remove && overrides.remove.length > 0) {
    const removeSet = new Set(overrides.remove.map(c => c.toLowerCase()));
    result = result.filter(c => !removeSet.has(c.name.toLowerCase()));
  }

  if (overrides.add && overrides.add.length > 0) {
    for (const name of overrides.add) {
      const existing = result.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (!existing) {
        result.push({ name, description: `Custom capability: ${name}`, confidence: 1.0 });
      }
    }
  }

  if (overrides.confidence) {
    for (const [name, confidence] of Object.entries(overrides.confidence)) {
      const cap = result.find(c => c.name.toLowerCase() === name.toLowerCase());
      if (cap) {
        cap.confidence = confidence;
      }
    }
  }

  return result;
}
