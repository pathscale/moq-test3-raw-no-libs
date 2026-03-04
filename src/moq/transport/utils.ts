export function debug(..._msg: any[]) {
    // disabled — was spamming console
}

export async function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}