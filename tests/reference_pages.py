"""Test fixture enumeration of bounded public dictionary pages only."""
def read_references(client, *, states=('active',), fields=('type','category','pack','size','unit')):
    result=[]
    for field in fields:
        for state in states:
            page=1
            while True:
                response=client.get('/api/v1/catalog/references/page',{'field':field,'state':state,'page':page})
                assert response.status_code==200,response.content
                data=response.json();result.extend(data['items'])
                if page>=data['pages']:break
                page+=1
    return result
