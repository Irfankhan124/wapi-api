import 'dotenv/config';

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/wapi';

export default {
  development: {
    mongoUri,
  },
  production: {
    mongoUri,
  },
  test: {
    mongoUri,
  },
};
