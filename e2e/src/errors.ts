/** A failure to report as is, with the exit code it ends the command with. */
export class E2eError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message)
    this.name = 'E2eError'
  }
}
