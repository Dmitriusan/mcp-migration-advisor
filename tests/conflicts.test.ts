import { describe, it, expect } from "vitest";
import { parseMigration } from "../src/parsers/flyway-sql.js";
import { detectConflicts, formatConflictReport } from "../src/analyzers/conflicts.js";

function makeReport(sqlA: string, sqlB: string, filenameA = "V1__a.sql", filenameB = "V2__b.sql") {
  const migA = parseMigration(filenameA, sqlA);
  const migB = parseMigration(filenameB, sqlB);
  return detectConflicts(migA, migB);
}

describe("detectConflicts — no conflicts", () => {
  it("should report no conflicts for unrelated tables", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
      "ALTER TABLE orders ADD COLUMN status VARCHAR(50);",
    );
    expect(result.conflicts.length).toBe(0);
    expect(result.canRunConcurrently).toBe(true);
  });

  it("should report no conflicts for CREATE on different tables", () => {
    const result = makeReport(
      "CREATE TABLE users (id SERIAL PRIMARY KEY);",
      "CREATE TABLE orders (id SERIAL PRIMARY KEY);",
    );
    expect(result.conflicts.length).toBe(0);
  });
});

describe("detectConflicts — same column conflicts", () => {
  it("should detect both migrations modifying the same column", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
      "ALTER TABLE users ADD COLUMN email TEXT;",
    );
    expect(result.conflicts.length).toBeGreaterThan(0);
    const columnConflict = result.conflicts.find((c) => c.type === "SAME_COLUMN");
    expect(columnConflict).toBeDefined();
    expect(columnConflict!.severity).toBe("CRITICAL");
    expect(columnConflict!.table).toBe("users");
    expect(columnConflict!.column).toBe("email");
  });

  it("should be case-insensitive for column names", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN Email VARCHAR(255);",
      "ALTER TABLE users DROP COLUMN email;",
    );
    const columnConflict = result.conflicts.find((c) => c.type === "SAME_COLUMN");
    expect(columnConflict).toBeDefined();
  });
});

describe("detectConflicts — lock contention", () => {
  it("should detect lock contention on the same table", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN first_name VARCHAR(100);",
      "ALTER TABLE users ADD COLUMN last_name VARCHAR(100);",
    );
    // Different columns but same table → lock contention
    const lockConflict = result.conflicts.find((c) => c.type === "LOCK_CONTENTION");
    expect(lockConflict).toBeDefined();
    expect(lockConflict!.severity).toBe("WARNING");
    expect(result.canRunConcurrently).toBe(false);
  });
});

describe("detectConflicts — drop dependency", () => {
  it("should detect drop table + modify same table conflict", () => {
    const result = makeReport(
      "DROP TABLE users;",
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
    );
    const dropConflict = result.conflicts.find((c) => c.type === "DROP_DEPENDENCY");
    expect(dropConflict).toBeDefined();
    expect(dropConflict!.severity).toBe("CRITICAL");
  });

  it("should detect modify + drop in reverse order", () => {
    const result = makeReport(
      "ALTER TABLE orders ADD COLUMN total DECIMAL(10,2);",
      "DROP TABLE orders;",
    );
    const dropConflict = result.conflicts.find((c) => c.type === "DROP_DEPENDENCY");
    expect(dropConflict).toBeDefined();
    expect(dropConflict!.severity).toBe("CRITICAL");
  });
});

describe("detectConflicts — multiple tables", () => {
  it("should only flag conflicting tables, not all", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);\nALTER TABLE orders ADD COLUMN total DECIMAL;",
      "ALTER TABLE users ADD COLUMN phone VARCHAR(20);\nCREATE TABLE products (id SERIAL);",
    );
    // Only users has overlap — orders and products don't conflict
    const userConflicts = result.conflicts.filter((c) => c.table === "users");
    expect(userConflicts.length).toBeGreaterThan(0);
    const orderConflicts = result.conflicts.filter((c) => c.table === "orders");
    expect(orderConflicts.length).toBe(0);
  });
});

describe("detectConflicts — filenames in report", () => {
  it("should include migration filenames in report", () => {
    const result = makeReport(
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
      "ALTER TABLE orders ADD COLUMN status VARCHAR(50);",
      "V3__add_email.sql",
      "V4__add_status.sql",
    );
    expect(result.migrationA).toBe("V3__add_email.sql");
    expect(result.migrationB).toBe("V4__add_status.sql");
  });
});

describe("formatConflictReport", () => {
  it("should format a clean report when no conflicts", () => {
    const result = makeReport(
      "CREATE TABLE a (id INT);",
      "CREATE TABLE b (id INT);",
    );
    const formatted = formatConflictReport(result);
    expect(formatted).toContain("No conflicts detected");
    expect(formatted).toContain("safely");
  });

  it("should include critical and warning sections", () => {
    const result = makeReport(
      "DROP TABLE users;",
      "ALTER TABLE users ADD COLUMN email VARCHAR(255);",
    );
    const formatted = formatConflictReport(result);
    expect(formatted).toContain("Critical Conflicts");
    expect(formatted).toContain("DROP_DEPENDENCY");
  });
});
