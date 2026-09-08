const express=require('express'); const router=express.Router();
const { authMiddleware }=require('../middleware/auth');
const store=require('../services/store');
router.get('/', authMiddleware, (req,res)=>res.json(store.getNetworks()));
router.post('/', authMiddleware, (req,res)=>res.status(201).json(store.addNetwork(req.body)));
router.delete('/:id', authMiddleware, (req,res)=>{ store.removeNetwork(req.params.id); res.json({ok:true}); });
module.exports=router;
