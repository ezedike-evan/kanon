import { describe, expect, it } from "vitest";
import { cleanUserInput, usernameKey, validateUserInput } from "./usersLogic";

const ok = { name: "Ada", username: "ada_1", experience: "Some" };

describe("validateUserInput", () => {
  it("accepts a normal user", () => expect(validateUserInput(ok)).toEqual([]));
  it("rejects short, long and odd usernames with a message", () => {
    expect(validateUserInput({ ...ok, username: "ab" })[0]?.field).toBe("username");
    expect(validateUserInput({ ...ok, username: "a".repeat(21) })[0]?.message).toContain("3 to 20");
    expect(validateUserInput({ ...ok, username: "ada lovelace" })[0]?.message).toContain("letters, numbers");
    expect(validateUserInput({ ...ok, username: "ada<script>" })).toHaveLength(1);
  });
  it("bounds name and experience and rejects control characters", () => {
    expect(validateUserInput({ ...ok, name: "" })[0]?.field).toBe("name");
    expect(validateUserInput({ ...ok, name: "x".repeat(61) })[0]?.field).toBe("name");
    expect(validateUserInput({ ...ok, name: "a\u0000b" })[0]?.field).toBe("name");
    expect(validateUserInput({ ...ok, experience: "x".repeat(41) })[0]?.field).toBe("experience");
  });
  it("checks email only when given", () => {
    expect(validateUserInput({ ...ok, email: "" })).toEqual([]);
    expect(validateUserInput({ ...ok, email: "nope" })[0]?.field).toBe("email");
    expect(validateUserInput({ ...ok, email: "a@b.co" })).toEqual([]);
  });
  it("reports every failing field", () => {
    expect(validateUserInput({ name: "", username: "!", experience: "" }).map((p) => p.field)).toEqual([
      "name",
      "username",
      "experience",
    ]);
  });
});

describe("cleaning", () => {
  it("trims whitespace", () => {
    expect(cleanUserInput({ name: " Ada ", username: " Ada_1", experience: "Some ", email: " a@b.co " })).toEqual({
      name: "Ada",
      username: "Ada_1",
      experience: "Some",
      email: "a@b.co",
    });
  });
  it("keys usernames case-insensitively", () => expect(usernameKey(" AdA_1 ")).toBe("ada_1"));
});
