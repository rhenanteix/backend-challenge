export class InvalidWagerMessageError extends Error {
    constructor(
        public readonly code: string,
    ) {
        super(code);
        this.name = 'InvalidWagerMessageError';
    }
}