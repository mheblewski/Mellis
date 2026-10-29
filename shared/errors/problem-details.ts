export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  errors?: Array<{ field: string; message: string }>;
}

export function toProblemDetails(input: {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  instance?: string;
  errors?: Array<{ field: string; message: string }>;
}): ProblemDetails {
  return input;
}