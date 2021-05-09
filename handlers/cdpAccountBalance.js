import { getJsonData } from '../lib/data.js';
import { DateTime } from 'luxon';
import { v4 as uuidv4} from 'uuid';

const data = getJsonData('cdpMockAccountData.json');

const getStatus = (returnCode, returnMsg, internalErrCode = null, internalErrReason = null) => ({
  "requestId": uuidv4(),
  "timestamp": DateTime.utc().toISO(),
  "internalErrCode": internalErrCode,
  "internalErrReason": internalErrReason,
  "returnCode": returnCode,
  "returnMsg": returnMsg
})

const getDataForId = id => data.find(entry => entry.id === id);

const getResponseForId = id => {
  const data = getDataForId(id);
  const response = data ? data.accounts : null;
  const status = data ? getStatus('0000', 'Success') : getStatus('400', 'Not found');
  return { status, response };
}

const getNotFoundResponse = () => {
  const status = getStatus("400", "Bad Request");
  return { status, response: null };
}

export const get = (req, res) => {
  let {id, idType, issuingCountry} = req.params;
  if (!id || !idType || !issuingCountry || idType.toLowerCase() !== 'nric' || issuingCountry.toLowerCase() !== 'sg') {
    return res.status(404).json(getNotFoundResponse());
  }
  const data = getResponseForId(id);
  if (data.status.returnCode === '400') {
    return res.status(400).json(data);
  }
  return res.json(data);
}