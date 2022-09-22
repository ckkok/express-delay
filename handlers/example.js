import { getJsonData } from '../lib/data.js';

export const get = (request, response) => {
  return response.json(getJsonData('exampleData.json'));
}