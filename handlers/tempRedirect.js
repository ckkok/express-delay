export const get = (request, response) => {
  console.log(request.query);
  const { client_id: clientId, Signature: signature } = request.query;
  response.status(302);
  return response.redirect(`https://sgfindex.qasgx.com/login.html?client_id=${clientId}&Signature=${signature}`);
}