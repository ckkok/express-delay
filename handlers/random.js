export const post = (req, res) => {
    res.end((Math.random() * 10).toString());
}

export const get = (req, res) => {
    res.json(globalThis.SERVER_STATE);
}