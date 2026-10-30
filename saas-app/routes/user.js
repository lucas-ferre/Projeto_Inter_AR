const express = require('express');
const {
  listUsers,
  addUser,
  getUser,
  updateUser,
  removeUser,
} = require('../controllers/userController');
const verifyToken = require('../middleware/verifyToken');
const requireAdmin = require('../middleware/requireAdmin');
const { validateUserCreation, validateUserUpdate } = require('../middleware/validateRequest');

const router = express.Router();

router.get('/', verifyToken, listUsers);
router.post('/', verifyToken, requireAdmin, validateUserCreation, addUser);
router.get('/:id', verifyToken, getUser);
router.put('/:id', verifyToken, validateUserUpdate, updateUser);
router.patch('/:id', verifyToken, validateUserUpdate, updateUser);
router.delete('/:id', verifyToken, requireAdmin, removeUser);

module.exports = router;
