const test = require('node:test');
const assert = require('node:assert/strict');
const { createPhotoUploadHandler } = require('../services/profilePhotoUpload');
const photo = Buffer.from([255,216,255,224,0,16,74,70,73,70,255,217]).toString('base64');
const response = () => ({ code: 200, status(value) { this.code=value;return this; },json(value){this.body=value;return this;} });
test('profile photo upload validates image bytes before contacting storage', async () => {
 let calls=0;const handler=createPhotoUploadHandler(async()=>{calls++;});
 for(const image of ['', 'not base64', Buffer.from('<script>bad</script>').toString('base64')]) {
  const res=response();await handler({body:{image}},res);assert.equal(res.code,400);
 }
 assert.equal(calls,0);
});
test('profile photo upload returns only the hosted HTTPS URL; storage failures preserve the account', async () => {
 let fail=false;
 const handler=createPhotoUploadHandler(async(url,options)=>{
  assert.equal(options.body.get('image'),photo);
  assert.equal(options.headers,undefined,'account authorization is not forwarded to storage');
  return {ok:!fail,json:async()=>({success:!fail,data:{url:'https://images.example.test/avatar.jpg'}})};
 });
 let res=response();await handler({body:{image:photo}},res);assert.equal(res.code,200);assert.deepEqual(res.body,{profilePic:'https://images.example.test/avatar.jpg'});
 fail=true;res=response();await handler({body:{image:photo}},res);assert.equal(res.code,502);assert.match(res.body.error,/try again/);
});
