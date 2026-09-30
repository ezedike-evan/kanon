/** Pure validation for `users:createUser`. Clear messages, one per field. */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const NAME_MAX = 60;
export const EXPERIENCE_MAX = 40;
export const EMAIL_MAX = 254;

export interface UserInput {
  name: string;
  username: string;
  experience: string;
  email?: string | undefined;
}

export interface UserProblem {
  field: "name" | "username" | "experience" | "email";
  message: string;
}

const USERNAME_CHARS = /^[A-Za-z0-9_]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The stored form of a field: surrounding whitespace is never part of a value. */
export const cleanUserInput = (i: UserInput): UserInput => ({
  name: i.name.trim(),
  username: i.username.trim(),
  experience: i.experience.trim(),
  ...(i.email !== undefined ? { email: i.email.trim() } : {}),
});

export const usernameKey = (username: string): string => username.trim().toLowerCase();

/** Validates already-cleaned input. Empty array means acceptable. */
export function validateUserInput(i: UserInput): UserProblem[] {
  const problems: UserProblem[] = [];
  if (i.name.length < 1) problems.push({ field: "name", message: "Enter a name." });
  else if (i.name.length > NAME_MAX) problems.push({ field: "name", message: `Name must be ${NAME_MAX} characters or fewer.` });
  else if (CONTROL.test(i.name)) problems.push({ field: "name", message: "Name cannot contain control characters." });

  if (i.username.length < USERNAME_MIN || i.username.length > USERNAME_MAX) {
    problems.push({ field: "username", message: `Username must be ${USERNAME_MIN} to ${USERNAME_MAX} characters.` });
  } else if (!USERNAME_CHARS.test(i.username)) {
    problems.push({ field: "username", message: "Username can use letters, numbers and underscores only." });
  }

  if (i.experience.length < 1) problems.push({ field: "experience", message: "Choose an experience level." });
  else if (i.experience.length > EXPERIENCE_MAX || CONTROL.test(i.experience)) {
    problems.push({ field: "experience", message: `Experience must be ${EXPERIENCE_MAX} characters or fewer.` });
  }

  if (i.email !== undefined && i.email !== "") {
    if (i.email.length > EMAIL_MAX || !EMAIL.test(i.email)) problems.push({ field: "email", message: "Enter a valid email address." });
  }
  return problems;
}
