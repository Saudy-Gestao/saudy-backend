-- Verificar estado atual das filiais
SELECT 
    b.id,
    b."tradeName" as filial,
    b."isMatriz" as "É Matriz?",
    c."tradeName" as empresa,
    b."companyId"
FROM branches b
JOIN companies c ON b."companyId" = c.id
ORDER BY c.id, b.id;
