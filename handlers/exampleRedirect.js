export const get = (request, response) => {
  response.status(302);
  return response.redirect(`https://jsonplaceholder.typicode.com/todos/1`);
}